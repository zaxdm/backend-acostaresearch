'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const secretos = require('../../shared/utils/secretos');
const { ValidationError, NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const mapper = require('../references/zotero.mapper');
const propiasRepository = require('../references/propias.repository');
const oauth = require('./oauth1');
const cliente = require('./biblioteca.client');
const repositorio = require('./biblioteca.repository');

/**
 * Conectar el Zotero de un tesista y traerse la colección que elija.
 *
 * TRES COSAS QUE NO SON OBVIAS Y GOBIERNAN TODO ESTE ARCHIVO
 * ----------------------------------------------------------
 * 1. Sus fuentes entran por el MISMO camino que su export de Scopus
 *    (`propias.repository`), identificadas por `sourceRef`. No por `zoteroKey`,
 *    que es única en toda la tabla y es del corpus de la casa: las claves de
 *    ítem de Zotero solo son únicas dentro de su biblioteca, así que dos
 *    tesistas pueden traer la misma y se pisarían.
 *
 * 2. Se sincroniza LO QUE ÉL ELIJA: una colección suya, o la biblioteca
 *    entera para quien no usa carpetas. La limpieza compara contra las claves
 *    vivas de eso mismo, no contra lo borrado en Zotero: sacar una fuente de la
 *    colección es lo que hace el tesista de verdad, y para «lo borrado» eso no
 *    ha ocurrido.
 *
 * 3. La clave nunca sale de la base en claro. Se descifra en memoria para cada
 *    pasada y no se devuelve nunca al panel, ni siquiera enmascarada.
 */

/** Donde vuelve el tesista desde zotero.org. Pasa por el proxy de la web. */
const urlDeVuelta = () => `${env.APP_URL}/api/v1/mi-zotero/vuelta`;

/** A dónde se le manda después, con el resultado en la dirección. */
const urlDelPanel = (resultado) => `${env.APP_URL}/perfil?zotero=${resultado}`;

function exigirQueEsteEncendido() {
  if (!env.zoteroOauthEnabled) {
    throw new ValidationError(
      'Conectar Zotero no está configurado en este servidor: faltan las claves de la aplicación.',
    );
  }
}

/** El contexto de lectura de una persona: su id de Zotero y su clave en claro. */
function contextoDe(cuenta) {
  return {
    zoteroUserId: cuenta.zoteroUserId,
    apiKey: secretos.descifrar(cuenta.apiKeyCipher),
  };
}

async function exigirCuenta(userId) {
  const cuenta = await repositorio.deUsuario(userId);
  if (!cuenta) throw new NotFoundError('No tienes ningún Zotero conectado.');
  return cuenta;
}

// ── Conectar ────────────────────────────────────────────────────────────────

/**
 * Paso 1: se le devuelve la dirección a la que ir.
 *
 * No se le redirige desde aquí: esto lo llama el panel por detrás, y una
 * redirección dentro de una llamada de datos acabaría siguiéndola el propio
 * navegador sin enseñarle a dónde va. Se le da la URL y el panel la abre.
 */
async function empezar(userId) {
  exigirQueEsteEncendido();

  const { token, secreto } = await oauth.pedirTokenTemporal(urlDeVuelta());

  await repositorio.guardarPeticion({
    token,
    secretCipher: secretos.cifrar(secreto),
    userId,
  });

  return { url: oauth.urlDeAutorizacion(token) };
}

/**
 * Paso 3: vuelve de zotero.org con el token y el verificador.
 *
 * La identidad sale de la fila que se guardó al empezar, NO de la sesión: el
 * tesista llega desde otro dominio y su cookie podría no viajar. Además, así el
 * token de uno no puede canjearlo otro aunque se lo copie del historial.
 */
async function terminar({ token, verificador }) {
  exigirQueEsteEncendido();

  const peticion = await repositorio.tomarPeticion(token);
  if (!peticion) {
    throw new ValidationError('Esta autorización ya se usó o caducó. Vuelve a empezar.');
  }

  const acceso = await oauth.canjear({
    token,
    secreto: secretos.descifrar(peticion.secretCipher),
    verificador,
  });

  await repositorio.guardarConexion({
    userId: peticion.userId,
    zoteroUserId: acceso.zoteroUserId,
    username: acceso.username,
    apiKeyCipher: secretos.cifrar(acceso.apiKey),
  });

  logger.info(
    { userId: peticion.userId, zoteroUserId: acceso.zoteroUserId },
    'Un comprador conectó su Zotero',
  );

  return { userId: peticion.userId };
}

// ── Elegir qué se trae ──────────────────────────────────────────────────────

/**
 * Sus colecciones, y la biblioteca entera como una opción más.
 *
 * La entera va primera y con su cuenta de fuentes delante. No es un capricho de
 * orden: hay tesistas que no usan carpetas —lo tienen todo suelto en la raíz— y
 * a esos la pantalla anterior les decía «crea una colección y vuelve», que es
 * mandarles a hacer deberes antes de poder usar lo que pagaron.
 */
async function colecciones(userId) {
  const cuenta = await exigirCuenta(userId);
  const contexto = contextoDe(cuenta);

  const [suyas, enLaBiblioteca] = await Promise.all([
    cliente.colecciones(contexto),
    cliente.cuantasEnLaBiblioteca(contexto).catch(() => null),
  ]);

  return {
    biblioteca: { clave: cliente.TODA_LA_BIBLIOTECA, cuantas: enLaBiblioteca },
    colecciones: suyas,
  };
}

/**
 * Elige la colección y trae lo que haya, sin esperar a la noche.
 *
 * La primera pasada se lanza aquí mismo y no se espera: una colección de
 * doscientas fuentes son dos o tres peticiones a Zotero, pero eso no lo decide
 * este código y una petición HTTP colgada tres minutos es una pantalla en
 * blanco. El panel pregunta por el estado.
 */
async function elegir(userId, claveColeccion) {
  const cuenta = await exigirCuenta(userId);

  // «Toda la biblioteca» no se comprueba contra la lista porque no está en
  // ella: no es una colección suya, es la ausencia de colección.
  const elegida =
    claveColeccion === cliente.TODA_LA_BIBLIOTECA
      ? { clave: cliente.TODA_LA_BIBLIOTECA, nombre: 'Toda tu biblioteca' }
      : (await cliente.colecciones(contextoDe(cuenta))).find(
          (coleccion) => coleccion.clave === claveColeccion,
        );

  if (!elegida) throw new NotFoundError('Esa colección no está en tu Zotero.');

  await repositorio.elegirColeccion(userId, {
    collectionKey: elegida.clave,
    collectionName: elegida.nombre.slice(0, 200),
  });

  sincronizar(userId).catch((fallo) =>
    logger.error({ err: fallo, userId }, 'Falló la primera pasada de una biblioteca'),
  );

  return { coleccion: elegida };
}

// ── Traerse las fuentes ─────────────────────────────────────────────────────

/**
 * Una pasada sobre la colección de una persona.
 *
 * Incremental por el marcador de versión, igual que el corpus de la casa: a
 * Zotero se le pide «lo tocado desde», que en una colección que no cambió es una
 * respuesta vacía y punto.
 *
 * El tope por usuario se comprueba ANTES de escribir. Con 5.000 fuentes por
 * cabeza nadie se acerca sincronizando una colección de tesis, pero el tope
 * existe para que la base no sea de quien más suba, y una vía de entrada que no
 * lo mire es la vía por la que se salta.
 */
async function correr(userId) {
  const cuenta = await exigirCuenta(userId);
  if (!cuenta.collectionKey) {
    throw new ValidationError('Elige primero qué colección quieres traer.');
  }

  const contexto = contextoDe(cuenta);
  const desde = cuenta.libraryVersion;
  let version = desde;
  let guardadas = 0;

  const yaTiene = await propiasRepository.contar(userId);
  let cupo = propiasRepository.TOPE_POR_USUARIO - yaTiene;

  for await (const pagina of cliente.paginasDeItems(contexto, {
    collectionKey: cuenta.collectionKey,
    desdeVersion: desde,
  })) {
    if (pagina.versionBiblioteca) version = pagina.versionBiblioteca;

    const filas = [];
    for (const item of pagina.items) {
      if (!mapper.esFuente(item)) continue;

      const { fila } = mapper.aFila(item);
      filas.push({
        ...fila,
        // La identidad es el `sourceRef`, no la clave de Zotero: ver arriba.
        zoteroKey: null,
        sourceRef: `${repositorio.prefijoDe(cuenta.zoteroUserId)}${item.data.key}`.slice(0, 200),
        origin: 'ZOTERO',
      });
    }

    // El cupo solo lo gastan las nuevas, y cuáles son nuevas lo sabe el
    // repositorio. Se corta el lote por lo alto y se para: mejor traer las
    // primeras y decirlo que rechazar la pasada entera.
    const lote = cupo > 0 ? filas.slice(0, cupo) : [];
    if (lote.length > 0) {
      const escrito = await propiasRepository.guardarLote(userId, lote);
      guardadas += escrito.guardadas;
      cupo -= escrito.guardadas;
    }
    if (cupo <= 0) break;
  }

  // Lo que salió de la colección se va de aquí. Una sola petición.
  const vivas = await cliente.clavesDeLaColeccion(contexto, cuenta.collectionKey);
  const retiradas = await repositorio.borrarLasQueYaNoEstan(userId, cuenta.zoteroUserId, vivas);

  const total = await repositorio.contarDeZotero(userId, cuenta.zoteroUserId);
  await repositorio.guardarPasada(userId, { libraryVersion: version, lastCount: total });

  logger.info(
    { userId, desde, hasta: version, guardadas, retiradas, total },
    'Biblioteca de un comprador sincronizada desde su Zotero',
  );

  return { guardadas, retiradas, total };
}

/**
 * Lo mismo, con el turno tomado y soltado pase lo que pase.
 *
 * El cerrojo que no se suelta es peor que el choque que evita: bloquearía a esa
 * persona para siempre y en silencio, así que va en un `finally` y su fallo se
 * registra aparte.
 */
async function sincronizar(userId) {
  const suyo = await repositorio.tomarElTurno(userId);
  if (!suyo) {
    throw new ConflictError('Ya se está trayendo tu biblioteca. Espera a que termine.');
  }

  try {
    return await correr(userId);
  } catch (fallo) {
    const mensaje = fallo.revocada
      ? 'Zotero ya no acepta la conexión. Vuelve a conectar tu cuenta.'
      : fallo.message;

    await repositorio.anotarFallo(userId, mensaje).catch(() => {});
    logger.error({ err: fallo, userId }, 'Falló la sincronización de una biblioteca');
    throw fallo;
  } finally {
    try {
      await repositorio.soltarElTurno(userId);
    } catch (fallo) {
      logger.error({ err: fallo, userId }, 'No se pudo soltar el turno de una biblioteca');
    }
  }
}

// ── Lo que ve el panel ──────────────────────────────────────────────────────

async function estado(userId) {
  const cuenta = await repositorio.deUsuario(userId);

  if (!cuenta) {
    return { disponible: env.zoteroOauthEnabled, conectado: false };
  }

  return {
    disponible: env.zoteroOauthEnabled,
    conectado: true,
    usuario: cuenta.username,
    coleccion: cuenta.collectionKey
      ? { clave: cuenta.collectionKey, nombre: cuenta.collectionName }
      : null,
    fuentes: cuenta.lastCount,
    ultima: cuenta.lastRunAt,
    trayendo: Boolean(cuenta.runningSince),
    error: cuenta.lastError,
  };
}

async function desconectar(userId) {
  await exigirCuenta(userId);
  await repositorio.desconectar(userId);
  // Las fuentes se quedan: están citadas en sus capítulos. Ver el repositorio.
  return { ok: true };
}

module.exports = {
  empezar,
  terminar,
  colecciones,
  elegir,
  sincronizar,
  estado,
  desconectar,
  urlDelPanel,
};
