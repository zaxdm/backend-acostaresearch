'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const secretos = require('../../shared/utils/secretos');
const { ValidationError, NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const propiasRepository = require('../references/propias.repository');
const { clavesCitadas } = require('../references/citadas');
const oauth = require('./mendeley.oauth');
const cliente = require('./mendeley.client');
const mapper = require('./mendeley.mapper');
const repositorio = require('./mendeley.repository');

/**
 * Conectar el Mendeley de un tesista y traerse la carpeta que elija.
 *
 * Es el gemelo de `zotero/biblioteca.service`, y las reglas que gobiernan aquel
 * gobiernan este: sus fuentes entran por `propias.repository` con identidad
 * propia (`mendeley:<perfil>:<documento>`), se trae SOLO lo que él elija, y los
 * tokens no salen nunca en claro de la base.
 *
 * LA DIFERENCIA QUE LO CAMBIA TODO: EL TOKEN CADUCA
 * ------------------------------------------------
 * La clave de Zotero no caduca. El token de Mendeley vive una hora, así que
 * cada pasada —la de la noche, la del botón— empieza renovándolo con el de
 * refresco. Si Mendeley rechaza el refresco, la conexión está muerta y se le
 * dice que vuelva a conectar; si no llegó a contestar, se reintenta mañana.
 */

/** Dónde se le manda después de autorizar, con el resultado en la dirección. */
const urlDelPanel = (resultado) => `${env.APP_URL}/perfil?mendeley=${resultado}`;

/** Un minuto antes de que venza, se renueva. */
const MARGEN_MS = 60_000;

function exigirQueEsteEncendido() {
  if (!env.mendeleyOauthEnabled) {
    throw new ValidationError(
      'Conectar Mendeley no está configurado en este servidor: faltan las claves de la aplicación.',
    );
  }
}

async function exigirCuenta(userId) {
  const cuenta = await repositorio.deUsuario(userId);
  if (!cuenta) throw new NotFoundError('No tienes ningún Mendeley conectado.');
  return cuenta;
}

/**
 * El token con el que leer, en claro y solo en memoria.
 *
 * Se renueva si le queda menos de un minuto. Un refresco RECHAZADO marca el
 * fallo con `revocada`, que es lo que hace que el panel diga «vuelve a
 * conectar» en vez de un error técnico.
 */
async function tokenVigente(cuenta) {
  const vigente = cuenta.expiresAt && cuenta.expiresAt.getTime() - MARGEN_MS > Date.now();
  if (vigente) return secretos.descifrar(cuenta.accessTokenCipher);

  if (!cuenta.refreshTokenCipher) {
    const fallo = new Error('La autorización de Mendeley venció. Vuelve a conectar tu cuenta.');
    fallo.revocada = true;
    throw fallo;
  }

  const tokens = await oauth.refrescar(secretos.descifrar(cuenta.refreshTokenCipher));

  await repositorio.guardarTokens(cuenta.userId, {
    accessTokenCipher: secretos.cifrar(tokens.accessToken),
    refreshTokenCipher: tokens.refreshToken ? secretos.cifrar(tokens.refreshToken) : null,
    expiresAt: new Date(Date.now() + tokens.expiraEn * 1000),
  });

  return tokens.accessToken;
}

// ── Conectar ────────────────────────────────────────────────────────────────

/** Paso 1: el `state` y la dirección. El panel la abre; aquí no se redirige. */
async function empezar(userId) {
  exigirQueEsteEncendido();

  const { state, url } = oauth.empezar();
  await repositorio.guardarEstado({ state, userId });

  // El `state` sale en crudo para que el controlador lo deje en una cookie
  // de este navegador. Ver `terminar`.
  return { url, state };
}

/**
 * Paso 3: vuelve de mendeley.com con el código.
 *
 * La identidad sale de la fila del `state`, no de la sesión. Y tiene que
 * volver EL MISMO navegador que empezó: sin eso, quien pulsara «conectar» con
 * su cuenta podría mandarle a otro la dirección de autorización y quedarse con
 * su biblioteca si la autorizaba.
 */
async function terminar({ codigo, state, stateDelNavegador }) {
  exigirQueEsteEncendido();

  if (!stateDelNavegador || stateDelNavegador !== state) {
    throw new ValidationError(
      'Esta autorización se empezó en otro navegador. Vuelve a tu perfil y pulsa «Conectar Mendeley» otra vez.',
    );
  }

  const pendiente = await repositorio.tomarEstado(state);
  if (!pendiente) {
    throw new ValidationError('Esta autorización ya se usó o caducó. Vuelve a empezar.');
  }

  const tokens = await oauth.canjear(codigo);
  const quien = await cliente.perfil(tokens.accessToken);

  await repositorio.guardarConexion({
    userId: pendiente.userId,
    profileId: String(quien.id).slice(0, 64),
    displayName: quien.nombre ? String(quien.nombre).slice(0, 200) : null,
    accessTokenCipher: secretos.cifrar(tokens.accessToken),
    refreshTokenCipher: tokens.refreshToken ? secretos.cifrar(tokens.refreshToken) : null,
    expiresAt: new Date(Date.now() + tokens.expiraEn * 1000),
  });

  logger.info({ userId: pendiente.userId }, 'Un comprador conectó su Mendeley');

  return { userId: pendiente.userId };
}

// ── Elegir qué se trae ──────────────────────────────────────────────────────

/**
 * Sus carpetas, y la biblioteca entera como una opción más.
 *
 * Misma forma que la respuesta de Zotero (`biblioteca` + `colecciones`), para
 * que la web pinte las dos con la misma pieza.
 */
async function carpetas(userId) {
  const cuenta = await exigirCuenta(userId);
  const token = await tokenVigente(cuenta);

  const [suyas, enLaBiblioteca] = await Promise.all([
    cliente.carpetas(token),
    cliente.cuantasEnLaBiblioteca(token).catch(() => null),
  ]);

  return {
    biblioteca: { clave: cliente.TODA_LA_BIBLIOTECA, cuantas: enLaBiblioteca },
    colecciones: suyas,
  };
}

/** Elige la carpeta y lanza la primera pasada sin esperarla. */
async function elegir(userId, clave) {
  const cuenta = await exigirCuenta(userId);

  const elegida =
    clave === cliente.TODA_LA_BIBLIOTECA
      ? { clave: cliente.TODA_LA_BIBLIOTECA, nombre: 'Toda tu biblioteca' }
      : (await cliente.carpetas(await tokenVigente(cuenta))).find((c) => c.clave === clave);

  if (!elegida) throw new NotFoundError('Esa carpeta no está en tu Mendeley.');

  await repositorio.elegirCarpeta(userId, {
    folderId: elegida.clave,
    folderName: elegida.nombre.slice(0, 200),
  });

  sincronizar(userId).catch((fallo) =>
    logger.error({ err: fallo, userId }, 'Falló la primera pasada de un Mendeley'),
  );

  return { coleccion: elegida };
}

// ── Traerse las fuentes ─────────────────────────────────────────────────────

/**
 * Una pasada sobre lo que eligió.
 *
 * No es incremental, a diferencia de Zotero, y a propósito: Mendeley no marca
 * como modificado un documento que se mete en una carpeta, así que «lo tocado
 * desde» se perdería justo lo que el tesista acaba de añadir a su carpeta de
 * tesis. Traerlo todo son un par de páginas de 500, y volver a escribir lo que
 * ya estaba solo refresca la ficha.
 *
 * La biblioteca se recorre ENTERA aunque se acabe el cupo: sin cupo no entra
 * nada nuevo, pero los ids hacen falta para la limpieza. Cortar el
 * recorrido a medias dejaría fuera de la lista de «vivos» fuentes que siguen
 * ahí, y la limpieza se las llevaría.
 */
async function correr(userId) {
  const cuenta = await exigirCuenta(userId);
  if (!cuenta.folderId) {
    throw new ValidationError('Elige primero qué carpeta quieres traer.');
  }

  const token = await tokenVigente(cuenta);
  const prefijo = repositorio.prefijoDe(cuenta.profileId);

  const idsDeLaCarpeta = await cliente.idsDeLaCarpeta(token, cuenta.folderId);
  const enLaCarpeta = idsDeLaCarpeta ? new Set(idsDeLaCarpeta) : null;

  const yaTiene = await propiasRepository.contar(userId);
  let cupo = propiasRepository.TOPE_POR_USUARIO - yaTiene;
  let guardadas = 0;
  const vistos = [];

  for await (const documentos of cliente.paginasDeDocumentos(token)) {
    const filas = [];
    for (const documento of documentos) {
      if (!mapper.esFuente(documento)) continue;
      if (enLaCarpeta && !enLaCarpeta.has(documento.id)) continue;

      vistos.push(documento.id);
      filas.push({ ...mapper.aFila(documento), sourceRef: `${prefijo}${documento.id}`.slice(0, 200) });
    }

    // El cupo lo gastan solo las nuevas. Las que ya tenía se refrescan
    // siempre; de las nuevas entran las que quepan.
    const conocidas = new Set(
      await propiasRepository.cualesTiene(userId, filas.map((fila) => fila.sourceRef)),
    );
    const yaEstaban = filas.filter((fila) => conocidas.has(fila.sourceRef));
    const nuevas = filas.filter((fila) => !conocidas.has(fila.sourceRef));
    const lote = [...yaEstaban, ...nuevas.slice(0, Math.max(cupo, 0))];

    if (lote.length > 0) {
      const escrito = await propiasRepository.guardarLote(userId, lote);
      guardadas += escrito.guardadas;
      cupo -= escrito.guardadas;
    }
  }

  const citadas = await clavesCitadas(userId);
  const retiradas = await repositorio.borrarLasQueYaNoEstan(
    userId,
    cuenta.profileId,
    idsDeLaCarpeta ?? vistos,
    citadas,
  );

  const total = await repositorio.contarDeMendeley(userId, cuenta.profileId);
  await repositorio.guardarPasada(userId, { lastCount: total });

  logger.info({ userId, guardadas, retiradas, total }, 'Biblioteca de un comprador sincronizada desde su Mendeley');

  return { guardadas, retiradas, total };
}

/** Con el turno tomado y soltado pase lo que pase. */
async function sincronizar(userId) {
  const suyo = await repositorio.tomarElTurno(userId);
  if (!suyo) {
    throw new ConflictError('Ya se está trayendo tu biblioteca. Espera a que termine.');
  }

  try {
    return await correr(userId);
  } catch (fallo) {
    const mensaje = fallo.revocada
      ? 'Mendeley ya no acepta la conexión. Vuelve a conectar tu cuenta.'
      : fallo.message;

    await repositorio.anotarFallo(userId, mensaje).catch(() => {});
    logger.error({ err: fallo, userId }, 'Falló la sincronización de un Mendeley');
    throw fallo;
  } finally {
    try {
      await repositorio.soltarElTurno(userId);
    } catch (fallo) {
      logger.error({ err: fallo, userId }, 'No se pudo soltar el turno de un Mendeley');
    }
  }
}

// ── Lo que ve el panel ──────────────────────────────────────────────────────

async function estado(userId) {
  const cuenta = await repositorio.deUsuario(userId);

  if (!cuenta) {
    return { disponible: env.mendeleyOauthEnabled, conectado: false };
  }

  return {
    disponible: env.mendeleyOauthEnabled,
    conectado: true,
    usuario: cuenta.displayName,
    coleccion: cuenta.folderId ? { clave: cuenta.folderId, nombre: cuenta.folderName } : null,
    fuentes: cuenta.lastCount,
    ultima: cuenta.lastRunAt,
    trayendo: Boolean(cuenta.runningSince),
    error: cuenta.lastError,
  };
}

async function desconectar(userId) {
  await exigirCuenta(userId);
  await repositorio.desconectar(userId);
  return { ok: true };
}

module.exports = {
  empezar,
  terminar,
  carpetas,
  elegir,
  sincronizar,
  estado,
  desconectar,
  tokenVigente,
  urlDelPanel,
};
