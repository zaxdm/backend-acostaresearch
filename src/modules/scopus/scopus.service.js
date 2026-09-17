'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
} = require('../../shared/errors/AppError');
const secretos = require('../../shared/utils/secretos');
const propiasRepository = require('../references/propias.repository');
const openalex = require('../references/openalex.client');
const crossref = require('../references/crossref.client');
const cliente = require('./scopus.client');
const mapper = require('./scopus.mapper');
const oauth = require('./scopus.oauth');
const repositorio = require('./scopus.repository');

/**
 * Conectar Scopus, buscar, elegir e importar.
 *
 * DÓNDE ACABA ESTE ARCHIVO Y EMPIEZA EL DE SIEMPRE
 * ------------------------------------------------
 * Aquí se habla con Elsevier y se decide qué se guarda. GUARDARLO lo hace
 * `references/propias.repository`, el mismo que escribe lo que sube por
 * archivo y lo que trae de su Zotero. No hay una segunda puerta a
 * `references`: esa tabla tiene filas de la casa —sin dueño, visibles para
 * todos— y filas de una persona, y la única forma de no confundirlas nunca es
 * que solo un archivo sepa escribirlas.
 *
 * LOS DOS MODOS DE ESTAR CONECTADO
 * --------------------------------
 * OAUTH  — el tesista autoriza en Elsevier y se guardan SUS tokens, cifrados.
 *          Requiere que Elsevier habilite el flujo para esta aplicación: hoy
 *          no lo da por autoservicio. Ver `scopus.oauth`.
 * APIKEY — se pregunta con la clave de la casa. «Conectar» no intercambia
 *          ninguna credencial: deja constancia de que esta persona aceptó las
 *          condiciones de uso del contenido de Elsevier, y enciende su
 *          buscador. Es lo que hay mientras Elsevier no conteste.
 *
 * El botón es el mismo y la pantalla es la misma. Lo que cambia por detrás es
 * con qué credencial se pregunta, y el panel lo dice sin rodeos.
 */

/**
 * A dónde vuelve el tesista, con el resultado en la dirección.
 *
 * `/perfil`, la MISMA que la vuelta de Zotero, y no `/mi-conector`: eso último
 * es el nombre del COMPONENTE que pinta la tarjeta, no una ruta de la web. El
 * comodín `**` de Angular manda a la portada cualquier cosa que no reconozca,
 * así que una ruta inventada no da error: deja al tesista en la página de
 * inicio preguntándose si autorizó o no. Hay una prueba que lo fija.
 */
const urlDelPanel = (resultado) => `${env.APP_URL}/perfil?scopus=${resultado}`;

/**
 * Cuántos artículos se pueden importar de una tacada.
 *
 * El tamaño de una página de resultados, que es lo que puede haber marcado.
 * Importar lo de varias páginas a la vez pediría guardar la selección entre
 * páginas, y eso es una función distinta con su propia forma de fallar.
 */
const MAXIMO_POR_IMPORTACION = cliente.POR_PAGINA;

function exigirQueEsteEncendido() {
  if (!env.scopusApiEnabled) {
    throw new AppError(
      'Buscar en Scopus desde aquí todavía no está disponible. Puedes buscar en Scopus con el ' +
        'acceso de tu universidad y subir el archivo que exportes: funciona igual.',
      { statusCode: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE },
    );
  }
}

async function exigirConexion(userId) {
  const conexion = await repositorio.deUsuario(userId);
  if (!conexion) {
    throw new NotFoundError('No tienes Scopus conectado. Pulsa «Conectar Scopus» y vuelve.');
  }

  if (conexion.status === 'REVOCADA') {
    throw new ForbiddenError(
      'Scopus dejó de aceptar tu conexión. Vuelve a conectarla desde tu perfil.',
    );
  }

  return conexion;
}

// ── Conectar ────────────────────────────────────────────────────────────────

/**
 * Paso 1.
 *
 * Con OAuth disponible devuelve la dirección a la que ir, y NO redirige desde
 * aquí: esto lo llama el panel por detrás, y una redirección dentro de una
 * llamada de datos la seguiría el propio cliente HTTP sin enseñarle al tesista
 * a dónde va. Sin OAuth, la conexión queda hecha en el momento y se le dice.
 */
async function empezar(userId) {
  exigirQueEsteEncendido();

  if (!env.scopusOauthEnabled) {
    await repositorio.guardarConexion({ userId, mode: 'APIKEY' });
    logger.info({ userId }, 'Un comprador conectó Scopus con la clave de la casa');
    return { conectado: true, url: null };
  }

  const { state, verificador, url } = oauth.empezar();

  await repositorio.guardarEstado({
    state,
    verifierCipher: secretos.cifrar(verificador),
    userId,
  });

  // El `state` sale también en crudo: el controlador lo guarda en una cookie
  // para reconocer al navegador cuando vuelva de Elsevier.
  return { conectado: false, url, state };
}

/**
 * Paso 3: vuelve de Elsevier con el código.
 *
 * La identidad sale de la fila que se guardó al empezar, NO de la sesión: el
 * tesista llega desde otro dominio y su cookie podría no viajar. Además, así el
 * código de uno no puede canjearlo otro aunque se lo copie del historial.
 */
async function terminar({ state, codigo, stateDelNavegador }) {
  exigirQueEsteEncendido();

  /**
   * Tiene que volver EL MISMO navegador que empezó.
   *
   * Sin esto, quien pulsara «conectar» con su cuenta podía mandarle a un
   * tesista la dirección de autorización de Elsevier: si el tesista
   * autorizaba, sus tokens quedaban guardados en la cuenta del otro. El
   * navegador que empieza recibe este `state` en una cookie httpOnly —ver el
   * controlador— y aquí se exige que coincida.
   */
  if (!stateDelNavegador || stateDelNavegador !== state) {
    throw new ValidationError(
      'Esta autorización se empezó en otro navegador. Vuelve a tu perfil y pulsa «Conectar ' +
        'Scopus» otra vez.',
    );
  }

  const pendiente = await repositorio.tomarEstado(state);
  if (!pendiente) {
    throw new ValidationError('Esta autorización ya se usó o caducó. Vuelve a empezar.');
  }

  const tokens = await oauth.canjear({
    codigo,
    verificador: secretos.descifrar(pendiente.verifierCipher),
  });

  await repositorio.guardarConexion({
    userId: pendiente.userId,
    mode: 'OAUTH',
    scopusUserId: tokens.scopusUserId,
    scopusName: tokens.scopusName,
    accessTokenCipher: secretos.cifrar(tokens.accessToken),
    refreshTokenCipher: tokens.refreshToken ? secretos.cifrar(tokens.refreshToken) : null,
    expiresAt: new Date(Date.now() + tokens.expiraEn * 1000),
  });

  // Ni los tokens ni su longitud: solo que pasó y de quién.
  logger.info({ userId: pendiente.userId }, 'Un comprador conectó su Scopus por OAuth');

  return { userId: pendiente.userId };
}

// ── El token de acceso, vivo ────────────────────────────────────────────────

/**
 * Cuánto antes de que venza se renueva.
 *
 * Un minuto. Un token que caduca a mitad de la petición vuelve como 401 y el
 * tesista ve un error por algo que se veía venir; renovarlo un poco antes
 * cuesta una petición y quita ese caso entero.
 */
const MARGEN_MS = 60_000;

/**
 * El token con el que preguntar, o null si se pregunta con la clave de la casa.
 *
 * Lo devuelve EN CLARO y solo en memoria, para pasárselo al cliente HTTP. No
 * vuelve a la base, no se registra y no sale hacia el navegador por ningún
 * camino.
 */
async function tokenDe(conexion) {
  if (conexion.mode !== 'OAUTH' || !conexion.accessTokenCipher) return null;

  const vigente =
    !conexion.expiresAt || conexion.expiresAt.getTime() - MARGEN_MS > Date.now();
  if (vigente) return secretos.descifrar(conexion.accessTokenCipher);

  if (!conexion.refreshTokenCipher) {
    await repositorio.anotarFallo(
      conexion.userId,
      'La autorización de Scopus venció y no hay forma de renovarla.',
      'CADUCADA',
    );
    throw new AppError('Tu autorización de Scopus venció. Vuelve a conectarla desde tu perfil.', {
      statusCode: 401,
      code: ERROR_CODES.TOKEN_EXPIRED,
    });
  }

  try {
    const tokens = await oauth.refrescar(secretos.descifrar(conexion.refreshTokenCipher));

    await repositorio.guardarTokens(conexion.userId, {
      accessTokenCipher: secretos.cifrar(tokens.accessToken),
      refreshTokenCipher: tokens.refreshToken ? secretos.cifrar(tokens.refreshToken) : null,
      expiresAt: new Date(Date.now() + tokens.expiraEn * 1000),
    });

    return tokens.accessToken;
  } catch (fallo) {
    // Un refresco que Elsevier RECHAZA no se arregla reintentando: retiró el
    // permiso. Uno que no llegó a salir —red, tiempo agotado— sí, y dejar la
    // conexión marcada como revocada por un corte de red obligaría al tesista
    // a rehacer algo que no estaba roto.
    const revocada = fallo?.rechazadoPorElsevier === true;
    await repositorio
      .anotarFallo(
        conexion.userId,
        revocada
          ? 'Elsevier dejó de aceptar la conexión.'
          : 'No se pudo renovar la autorización de Scopus.',
        revocada ? 'REVOCADA' : 'CADUCADA',
      )
      .catch(() => {});
    throw fallo;
  }
}

// ── Buscar ──────────────────────────────────────────────────────────────────

/**
 * Una página de resultados de Scopus.
 *
 * La ecuación va TAL CUAL a Elsevier, sin que este servidor la reescriba. Es
 * el lenguaje de Scopus —`TITLE-ABS-KEY(...)`, `AND`, `OR`, comillas— y el
 * tesista ya lo tiene escrito: la skill del método se lo arma para que lo
 * pegue en Scopus, y es la misma cadena. Tocarla aquí significaría que la
 * búsqueda da un resultado distinto según dónde se pegue, que es la peor forma
 * de perder la confianza en un buscador.
 *
 * Lo que sí se hace es acotar su tamaño, en el esquema de la ruta.
 */
async function buscar(userId, { ecuacion, pagina = 1 }) {
  exigirQueEsteEncendido();
  const conexion = await exigirConexion(userId);

  const numero = Math.max(Math.trunc(Number(pagina)) || 1, 1);
  const desde = (numero - 1) * cliente.POR_PAGINA;

  const respuesta = await cliente.buscar({
    ecuacion,
    desde,
    cuantas: cliente.POR_PAGINA,
    accessToken: await tokenDe(conexion),
  });

  await repositorio.anotarBusqueda(userId).catch(() => {});

  const resultados = respuesta.fichas.map(mapper.comoResultado).filter((r) => r.eid);

  /**
   * Cuáles de estas ya tiene.
   *
   * Se marcan, no se esconden. Que una fuente ya esté en su biblioteca es un
   * dato útil —le dice que esa búsqueda ya la hizo— y quitarla de la lista
   * haría que los resultados no cuadraran con los que ve en Scopus.
   *
   * Se comprueba por `sourceRef`, que es la misma identidad que usa la
   * importación: así lo que aquí sale marcado es exactamente lo que allí se
   * va a contar como repetido.
   */
  const yaLasTiene = await claveDeLasQueYaTiene(userId, resultados);

  const paginas = Math.max(
    Math.ceil(Math.min(respuesta.total, cliente.TOPE_DE_DESPLAZAMIENTO) / cliente.POR_PAGINA),
    1,
  );

  return {
    total: respuesta.total,
    pagina: numero,
    paginas,
    desde: desde + 1,
    porPagina: cliente.POR_PAGINA,
    /** Sin token institucional las fichas llegan sin resumen. El panel lo dice. */
    conResumenes: env.scopusView === 'COMPLETE',
    resultados: resultados.map((resultado) => ({
      ...resultado,
      yaLaTienes: yaLasTiene.has(identidadDe(resultado)),
    })),
  };
}

/** La misma identidad que calcula el mapper, desde un resultado ya traducido. */
function identidadDe({ doi, eid, titulo }) {
  if (doi) return `doi:${doi.toLowerCase()}`;
  if (eid) return `eid:${eid}`;
  return `titulo:${String(titulo ?? '').toLowerCase()}`;
}

async function claveDeLasQueYaTiene(userId, resultados) {
  const claves = resultados.map(identidadDe).filter(Boolean);
  if (claves.length === 0) return new Set();

  const suyas = await propiasRepository.cualesTiene(userId, claves);
  return new Set(suyas);
}

// ── Importar ────────────────────────────────────────────────────────────────

/**
 * Trae a su biblioteca los artículos que marcó.
 *
 * LLEGAN IDENTIFICADORES, NO FICHAS
 * ---------------------------------
 * El navegador manda los EID de lo que marcó y este servidor vuelve a
 * pedírselos a Scopus. Podría mandar los datos bibliográficos que ya tiene en
 * pantalla y ahorrarse la petición, pero entonces lo que acabaría en la
 * biblioteca sería lo que dijera una petición del navegador, no lo que dijo
 * Elsevier: cualquiera podría meterse fuentes inventadas con el título y los
 * autores que quisiera, y después citarlas en su tesis como si fueran reales.
 *
 * Es el mismo criterio que la importación por DOI, que también manda solo el
 * identificador y deja que el servidor busque la ficha.
 */
async function importar(userId, { eids }) {
  exigirQueEsteEncendido();
  const conexion = await exigirConexion(userId);

  const lista = [...new Set((eids ?? []).map((eid) => String(eid).trim()))].filter(mapper.esEid);

  if (lista.length === 0) {
    throw new ValidationError('No marcaste ningún artículo.');
  }

  if (lista.length > MAXIMO_POR_IMPORTACION) {
    throw new ValidationError(
      `Puedes importar hasta ${MAXIMO_POR_IMPORTACION} de una vez, que es lo que cabe en una ` +
        'página de resultados.',
    );
  }

  // El tope se comprueba contra lo que YA tiene, igual que al subir un
  // archivo: quien importa de veinte en veinte se acerca igual que quien sube
  // un export de seiscientas.
  const tiene = await propiasRepository.contar(userId);
  if (tiene + lista.length > propiasRepository.TOPE_POR_USUARIO) {
    throw new AppError(
      `Tu biblioteca admite ${propiasRepository.TOPE_POR_USUARIO} fuentes y con esas pasarías de ` +
        `ahí (tienes ${tiene}).`,
      { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR },
    );
  }

  /**
   * Se piden por EID, que es un campo de búsqueda documentado de Scopus.
   *
   * Los veinticinco caben en una sola consulta, y cada EID pasó por
   * `mapper.esEid` antes de llegar aquí: sin esa comprobación, un texto con
   * paréntesis o un `OR` dentro cambiaría la ecuación entera.
   */
  const respuesta = await cliente.buscar({
    ecuacion: lista.map((eid) => `EID(${eid})`).join(' OR '),
    cuantas: lista.length,
    accessToken: await tokenDe(conexion),
  });

  const filas = await completarLasQueLleguenAMedias(respuesta.fichas);

  if (filas.length === 0) {
    throw new ValidationError(
      'Scopus ya no devuelve esos artículos. Vuelve a buscar y márcalos otra vez.',
    );
  }

  // El mismo `guardarLote` que usan el export y el Zotero del tesista: mismo
  // upsert por (dueño, sourceRef) y mismo cruce por DOI. Por eso importar dos
  // veces lo mismo, o importar algo que ya subió en un CSV, refresca la ficha
  // en vez de duplicarla.
  const { guardadas, repetidas } = await propiasRepository.guardarLote(userId, filas);

  await repositorio.sumarImportadas(userId, guardadas).catch(() => {});

  const sinResumen = filas.filter((fila) => !fila.abstract).length;

  logger.info(
    { userId, pedidas: lista.length, guardadas, repetidas, sinResumen },
    'Fuentes importadas desde la API de Scopus',
  );

  return {
    pedidas: lista.length,
    guardadas,
    repetidas,
    /** Las que Scopus ya no devuelve. Se nombran para poder decirlo. */
    noEncontradas: lista.length - filas.length,
    sinResumen,
    total: tiene + guardadas,
    sinResumenEnTotal: await propiasRepository.contarSinResumen(userId),
  };
}

/**
 * SCOPUS BUSCA, EL CATÁLOGO ABIERTO COMPLETA.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * Sin token institucional, Elsevier devuelve la vista STANDARD, y eso son dos
 * agujeros que se ven en el Word del tesista:
 *
 *   · sin RESUMEN, la fuente se guarda pero Claude no la encuentra al redactar
 *     —solo queda el título para buscarla—, que es justo lo que el panel lleva
 *     avisando desde que se sube un export sin «Abstract & keywords»;
 *   · `dc:creator` es UN SOLO autor. La bibliografía saldría «Brignole, M.» en
 *     un artículo con treinta firmantes.
 *
 * POR QUÉ ESTO NO ES UN APAÑO
 * ---------------------------
 * Cada catálogo hace lo que sabe hacer. Lo que se le pide a Scopus es lo que
 * solo Scopus tiene: SU índice, su lenguaje de ecuaciones —el mismo que el
 * tesista pega en la web de Scopus y que le arma la skill del método— y su
 * recuento de citas. Los metadatos bibliográficos de un artículo con DOI no son
 * secreto de nadie: están en Crossref porque los depositó el editor, y el
 * resumen está en OpenAlex.
 *
 * Es además exactamente lo que ya hace `propias.service.importarPorDoi`, con
 * los mismos dos clientes y el mismo orden de preferencia. Ver `scopus.mapper`.
 *
 * DE UNA EN UNA, NO EN PARALELO
 * -----------------------------
 * Son servicios ajenos y gratuitos, y lanzarles veinticinco peticiones a la vez
 * es la forma de que empiecen a rechazarlas. Veinticinco secuenciales son unos
 * segundos, y esto ocurre una vez por importación, no en cada búsqueda.
 */
async function completarLasQueLleguenAMedias(fichas) {
  const filas = [];

  for (const ficha of fichas) {
    const fila = mapper.comoFila(ficha);
    if (!fila) continue;

    // Con token institucional Scopus ya lo manda todo: no se molesta a nadie.
    // Y sin DOI no hay por dónde preguntar.
    if (mapper.estaCompleta(ficha) || !fila.doi) {
      filas.push(fila);
      continue;
    }

    // Que un catálogo no conteste no puede tumbar la importación: lo que se
    // pierde es el resumen de esa ficha, no la ficha.
    const [deOpenAlex, deCrossref] = [
      await openalex.porDoi(fila.doi).catch(() => null),
      await crossref.porDoi(fila.doi).catch(() => null),
    ];

    filas.push(mapper.completar(fila, { deOpenAlex, deCrossref }));
  }

  return filas;
}

// ── Lo que ve el panel ──────────────────────────────────────────────────────

async function estado(userId) {
  const conexion = await repositorio.deUsuario(userId);

  const comun = {
    disponible: env.scopusApiEnabled,
    /** Con OAuth, «conectar» manda a Elsevier. Sin él, conecta en el momento. */
    conOauth: env.scopusOauthEnabled,
    /**
     * Si las fichas van a traer resumen.
     *
     * Es lo primero que hay que decirle, porque decide si esto le sirve: sin
     * token institucional, Elsevier devuelve la vista STANDARD —sin resumen,
     * sin palabras clave y con un solo autor— y una fuente así se puede citar
     * pero Claude no la va a encontrar cuando redacte.
     */
    conResumenes: env.scopusView === 'COMPLETE',
  };

  if (!conexion) return { ...comun, conectado: false };

  return {
    ...comun,
    conectado: conexion.status !== 'REVOCADA',
    estado: conexion.status,
    cuenta: conexion.scopusName,
    importadas: conexion.imported,
    ultimaBusqueda: conexion.lastSearchAt,
    error: conexion.lastError,
  };
}

async function desconectar(userId) {
  // No se pasa por `exigirConexion`: esa rechaza las REVOCADAS, y desconectar
  // una conexión que Elsevier ya revocó es justo lo que hay que poder hacer
  // para volver a empezar. Solo se comprueba que haya algo que desconectar.
  const conexion = await repositorio.deUsuario(userId);
  if (!conexion) throw new NotFoundError('No tienes Scopus conectado.');

  await repositorio.desconectar(userId);
  // Las fuentes se quedan: están citadas en sus capítulos. Ver el repositorio.
  return { ok: true };
}

module.exports = {
  empezar,
  terminar,
  buscar,
  importar,
  estado,
  desconectar,
  urlDelPanel,
  MAXIMO_POR_IMPORTACION,
};
