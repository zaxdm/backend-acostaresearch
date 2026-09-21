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
const enlaceAbierto = require('../references/enlaceAbierto');
const cliente = require('./scopus.client');
const mapper = require('./scopus.mapper');
const oauth = require('./scopus.oauth');
const repositorio = require('./scopus.repository');
const gemini = require('../../lib/gemini');

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
 * LOS DOS MODOS, Y POR QUÉ SOLO UNO TIENE BOTÓN
 * ---------------------------------------------
 * APIKEY — se pregunta con la clave de la casa, que es de este servidor. No hay
 *          ninguna credencial del tesista que intercambiar, así que TAMPOCO HAY
 *          NADA QUE CONECTAR: el buscador está desde el primer momento, igual
 *          que la caja de subir el archivo. Es lo que hay mientras Elsevier no
 *          habilite el OAuth.
 * OAUTH  — el tesista autoriza en Elsevier y se guardan SUS tokens, cifrados.
 *          Ahí sí hace falta conectar, porque sin sus tokens no hay con qué
 *          preguntar en su nombre. Ver `scopus.oauth`.
 *
 * Hubo un botón «Conectar Scopus» también en el primer modo, y se quitó el 17 de
 * septiembre de 2026: era un clic de trámite entre el tesista y el buscador que
 * no establecía nada, y dejaba un estado más que podía quedarse a medias.
 *
 * La fila de `scopus_connections` sigue existiendo en los dos modos, pero en el
 * primero es solo el contador de lo que ha importado: se crea sola al importar.
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

/**
 * La conexión con la que se va a preguntar, o `null` si no hace falta ninguna.
 *
 * SIN OAUTH NO HAY NADA QUE CONECTAR, Y POR ESO NO SE PIDE
 * -------------------------------------------------------
 * Se pregunta con la clave de la casa, que es de este servidor y no del
 * tesista. «Conectar» era entonces un botón que no intercambiaba ninguna
 * credencial: un clic de trámite entre él y el buscador, y un estado más que
 * podía quedarse a medias. Se quitó — el buscador está desde el primer momento,
 * como lo está la caja de subir el archivo.
 *
 * La fila sigue existiendo, pero para llevar la cuenta de lo que ha importado,
 * no para dar permiso. Se crea sola la primera vez que importa algo.
 *
 * CON OAUTH SÍ HACE FALTA, y entonces vuelve a exigirse: ahí la conexión son
 * SUS tokens, y sin ellos no hay con qué preguntar en su nombre.
 */
async function conexionParaUsar(userId) {
  const conexion = await repositorio.deUsuario(userId);

  if (!env.scopusOauthEnabled) return conexion;

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
  // Sin fila se pregunta con la clave de la casa, que es lo normal mientras
  // Elsevier no habilite el OAuth. Ver `conexionParaUsar`.
  if (!conexion || conexion.mode !== 'OAUTH' || !conexion.accessTokenCipher) return null;

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
async function buscar(userId, { ecuacion, pagina = 1, orden = 'citas' }) {
  exigirQueEsteEncendido();
  const conexion = await conexionParaUsar(userId);

  const numero = Math.max(Math.trunc(Number(pagina)) || 1, 1);
  const desde = (numero - 1) * cliente.POR_PAGINA;

  const respuesta = await cliente.buscar({
    ecuacion,
    desde,
    cuantas: cliente.POR_PAGINA,
    orden,
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
    orden: Object.hasOwn(cliente.ORDENES, orden) ? orden : 'citas',
    /** Sin token institucional las fichas llegan sin resumen. El panel lo dice. */
    conResumenes: env.scopusView === 'COMPLETE',
    /**
     * Dónde se lee gratis cada una, de los catálogos abiertos.
     *
     * Scopus dice SI un artículo es de acceso abierto pero no DÓNDE está la
     * copia, y sin el dónde la etiqueta no sirve de nada: el tesista veía
     * «Acceso abierto» y seguía sin poder leerlo. Se pide aquí y no cuando
     * pincha, como los resúmenes, porque la etiqueta ya está en pantalla desde
     * el primer momento y un cartel que promete acceso tiene que llevar a
     * alguna parte.
     *
     * Cuesta UNA consulta a OpenAlex por página —las veinticinco juntas— y
     * falla hacia el silencio: si no contesta, los resultados salen como antes.
     */
    resultados: await enlaceAbierto.pegarALosResultados(
      resultados.map((resultado) => ({
        ...resultado,
        yaLaTienes: yaLasTiene.has(identidadDe(resultado)),
      })),
    ),
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
  const conexion = await conexionParaUsar(userId);

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

  // La fila se crea aquí la primera vez, no al entrar en la pantalla: así una
  // visita que solo mira no deja rastro, y quien importa algo sí tiene dónde
  // llevar la cuenta. `sumarImportadas` es un update y sin fila no haría nada.
  if (!conexion) await repositorio.guardarConexion({ userId, mode: 'APIKEY' }).catch(() => {});
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

  /**
   * Sin OAuth se está conectado siempre que la función esté encendida.
   *
   * No es un atajo: es que no hay ningún vínculo que establecer. La web se
   * apoya en esto para no enseñar un botón de conectar que no conecta nada.
   */
  const conectadoDeSerie = !env.scopusOauthEnabled && env.scopusApiEnabled;

  if (!conexion) return { ...comun, conectado: conectadoDeSerie };

  return {
    ...comun,
    conectado: conectadoDeSerie || conexion.status !== 'REVOCADA',
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

// ── Cuántos hay en cada opción de un filtro ─────────────────────────────────

/**
 * Las opciones de los filtros que se cuentan con Scopus, con su cláusula.
 *
 * Solo las de lista corta y fija. Scopus no nos da sus facetas con esta clave
 * («not entitled to access facets»), así que cada número es una consulta de un
 * resultado contra la cuota de la casa: el área, con 27 opciones, se cuenta
 * aproximada con OpenAlex (ver `scopus.cuentas`). Los valores son los mismos
 * que usa la web en sus casillas.
 */
function opcionesDeLaFaceta(faceta) {
  const lista = (campo, valores) => valores.map((v) => ({ valor: v, clausula: `${campo}(${v})` }));
  switch (faceta) {
    case 'tipo':
      return lista('DOCTYPE', ['ar', 're', 'cp', 'ch', 'bk', 'cr', 'ed', 'le', 'no', 'sh', 'dp', 'er']);
    case 'idioma':
      return lista('LANGUAGE', ['english', 'spanish', 'portuguese', 'french', 'german', 'italian', 'chinese', 'russian']);
    case 'abierto':
      return lista('OA', ['all', 'publisherfullgold', 'publisherhybridgold', 'publisherfree2read', 'repository']);
    case 'fuente':
      return lista('SRCTYPE', ['j', 'p', 'b', 'k', 'd']);
    case 'etapa':
      return lista('PUBSTAGE', ['final', 'aip']);
    case 'anio': {
      // Los diez últimos años: es lo que dibuja la gráfica de barras, y lo
      // que mira un jurado.
      const este = new Date().getFullYear();
      return Array.from({ length: 10 }, (_, i) => este - 9 + i).map((anio) => ({
        valor: String(anio),
        clausula: `PUBYEAR = ${anio}`,
      }));
    }
    default:
      return [];
  }
}

/**
 * Lo ya contado, compartido entre tesistas: el número de una ecuación no
 * depende de quién pregunte, y volver a abrir una sección no debe gastar cuota.
 * Media hora y como mucho quinientas entradas.
 */
const CUENTAS_GUARDADAS = new Map();
const VIDA_DE_UNA_CUENTA_MS = 30 * 60 * 1000;

function cuentaGuardada(clave) {
  const guardada = CUENTAS_GUARDADAS.get(clave);
  if (!guardada) return undefined;
  if (Date.now() - guardada.cuando > VIDA_DE_UNA_CUENTA_MS) {
    CUENTAS_GUARDADAS.delete(clave);
    return undefined;
  }
  return guardada.valor;
}

function guardarCuenta(clave, valor) {
  if (CUENTAS_GUARDADAS.size >= 500) CUENTAS_GUARDADAS.delete(CUENTAS_GUARDADAS.keys().next().value);
  CUENTAS_GUARDADAS.set(clave, { valor, cuando: Date.now() });
}

/** De varias en varias, para no lanzar doce peticiones a la vez contra Elsevier. */
async function enTandas(tareas, deAVez = 4) {
  const resultados = new Array(tareas.length);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < tareas.length) {
      const i = siguiente++;
      resultados[i] = await tareas[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(deAVez, tareas.length) }, trabajador));
  return resultados;
}

/**
 * Cuántos resultados da la ecuación con cada opción de un filtro, exactos.
 *
 * Una consulta por opción, de un solo resultado —solo interesa el total—. Una
 * que falle deja su número en nulo y no tumba las demás.
 */
async function cuentas(userId, { ecuacion, faceta }) {
  exigirQueEsteEncendido();
  const opciones = opcionesDeLaFaceta(faceta);
  if (opciones.length === 0) throw new ValidationError('Ese filtro no se cuenta.');

  const clave = `${faceta}|${ecuacion}`;
  const guardada = cuentaGuardada(clave);
  if (guardada) return { faceta, cuentas: guardada };

  const conexion = await conexionParaUsar(userId);
  const accessToken = await tokenDe(conexion);

  const totales = await enTandas(
    opciones.map((opcion) => async () => {
      try {
        const { total } = await cliente.buscar({
          ecuacion: `(${ecuacion}) AND ${opcion.clausula}`,
          cuantas: 1,
          accessToken,
        });
        return total;
      } catch (fallo) {
        logger.warn({ err: fallo.message, faceta }, 'Scopus: no se pudo contar una opción');
        return null;
      }
    }),
  );

  const resultado = Object.fromEntries(opciones.map((opcion, i) => [opcion.valor, totales[i]]));
  if (totales.some((t) => t !== null)) guardarCuenta(clave, resultado);
  return { faceta, cuentas: resultado };
}

// ── Búsqueda semántica ─────────────────────────────────────────────────────

/**
 * Cuántos candidatos se ordenan por significado.
 *
 * Eran 75 —tres páginas de Scopus— y ordenaban mejor, pero el plan gratuito de
 * Gemini cuenta CADA TEXTO que se embebe, y no cada petición: cien al minuto
 * para toda la plataforma. Con 75 más la pregunta, la segunda búsqueda del
 * minuto se quedaba sin vectores. Con 40 caben dos.
 *
 * El día que la clave tenga facturación, esto vuelve a 75 y se acabó.
 */
const CANDIDATOS_SEMANTICA = 40;

/** Lo más que se espera a Gemini antes de dar el error. */
const ESPERA_MAXIMA_S = 20;

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/**
 * Cuántos segundos pide Gemini que se espere, o null si no es un tope.
 *
 * Lo dice en el texto del error —«Please retry in 8.563842925s.»— y a veces en
 * `retryDelay` («8s»). Se redondea hacia arriba y se suma uno: volver justo en
 * el borde es volver a chocar.
 */
function segundosParaReintentar(fallo) {
  const texto = String(fallo?.message ?? '');
  const esTope = fallo?.status === 429 || /quota|rate limit/i.test(texto);
  if (!esTope) return null;
  const dicho = texto.match(/retry in ([\d.]+)\s*s/i) ?? texto.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  return dicho ? Math.ceil(Number(dicho[1])) + 1 : null;
}

const coseno = (a, b) => {
  let producto = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i += 1) {
    producto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  return normaA && normaB ? producto / Math.sqrt(normaA * normaB) : 0;
};

/**
 * Los artículos más cercanos a la PREGUNTA, no a las palabras.
 *
 * Lo que hace la búsqueda semántica de Scopus, con lo nuestro: se traen los 40
 * más relevantes de la ecuación, se completan con su resumen de OpenAlex, y
 * se ordenan por lo parecido que es lo que dicen a lo que el tesista preguntó,
 * con los vectores de Gemini. Se devuelven los 25 más cercanos.
 *
 * Como el resumen con IA, pasa títulos de Scopus por Gemini; Benicio lo
 * decidió sabiéndolo el 19-sep-2026.
 */
async function buscarSemantica(
  userId,
  { ecuacion, pregunta },
  { embeber = gemini.embeber, resumenes = openalex.resumenesPorDoi, esperar = dormir } = {},
) {
  exigirQueEsteEncendido();
  if (!env.asistenteEnabled) {
    throw new AppError('La búsqueda por significado no está disponible ahora.', {
      statusCode: 503,
      code: ERROR_CODES.ASSISTANT_UNAVAILABLE,
    });
  }

  const conexion = await conexionParaUsar(userId);
  const accessToken = await tokenDe(conexion);

  const candidatos = [];
  let total = 0;
  for (let desde = 0; desde < CANDIDATOS_SEMANTICA; desde += cliente.POR_PAGINA) {
    const pagina = await cliente.buscar({ ecuacion, desde, orden: 'relevancia', accessToken });
    total = pagina.total;
    candidatos.push(...pagina.fichas.map(mapper.comoResultado).filter((r) => r.eid));
    if (candidatos.length >= total || pagina.fichas.length < cliente.POR_PAGINA) break;
  }
  /**
   * Y se recorta al número que se buscaba: Scopus da páginas de 25, y pedir
   * «hasta 40» trae dos enteras. Sin esto eran 50, 51 textos con la pregunta, y
   * dos búsquedas en un minuto volvían a pasar del tope de 100.
   */
  candidatos.length = Math.min(candidatos.length, CANDIDATOS_SEMANTICA);
  await repositorio.anotarBusqueda(userId).catch(() => {});

  if (candidatos.length === 0) {
    return { total: 0, pagina: 1, paginas: 1, desde: 1, porPagina: cliente.POR_PAGINA, candidatos: 0, semantica: true, orden: 'significado', conResumenes: env.scopusView === 'COMPLETE', resultados: [] };
  }

  const porDoi = await resumenes(candidatos.map((c) => c.doi).filter(Boolean)).catch(() => new Map());
  const textos = candidatos.map((c) => {
    const resumen = c.doi ? porDoi.get(c.doi.toLowerCase()) : null;
    return resumen ? `${c.titulo}. ${resumen.slice(0, 1500)}` : c.titulo;
  });

  const pedirVectores = async () => {
    const [consulta] = await embeber([pregunta], { tarea: 'RETRIEVAL_QUERY' });
    const documentos = await embeber(textos, { tarea: 'RETRIEVAL_DOCUMENT' });
    return { consulta, documentos };
  };

  let vectores;
  try {
    try {
      vectores = await pedirVectores();
    } catch (primero) {
      /**
       * Un tope de segundos se espera en el servidor; no llega al tesista.
       *
       * El tope de Gemini es por minuto y el propio error dice cuánto falta.
       * Se espera eso y se pide otra vez, una sola: lo ya calculado se
       * recuerda (ver `embeber`), así que solo se pide lo que faltó. Si pide
       * más de veinte segundos, se sigue como antes: con el error de siempre.
       */
      const espera = segundosParaReintentar(primero);
      if (espera === null || espera > ESPERA_MAXIMA_S) throw primero;
      logger.info({ espera }, 'Búsqueda semántica: tope del minuto, se espera y se reintenta');
      await esperar(espera * 1000);
      vectores = await pedirVectores();
    }
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'Búsqueda semántica: Gemini no dio los vectores');
    throw new AppError('La búsqueda por significado no contestó. Vuelve a intentarlo en un momento.', {
      statusCode: 503,
      code: ERROR_CODES.ASSISTANT_UNAVAILABLE,
    });
  }

  const ordenados = candidatos
    .map((c, i) => ({ ...c, afinidad: Number(coseno(vectores.consulta, vectores.documentos[i]).toFixed(3)) }))
    .sort((a, b) => b.afinidad - a.afinidad)
    .slice(0, cliente.POR_PAGINA);

  const yaLasTiene = await claveDeLasQueYaTiene(userId, ordenados);

  return {
    total,
    pagina: 1,
    paginas: 1,
    desde: 1,
    porPagina: cliente.POR_PAGINA,
    /** De cuántos se eligieron estos: los más relevantes de la ecuación. */
    candidatos: candidatos.length,
    semantica: true,
    orden: 'significado',
    conResumenes: env.scopusView === 'COMPLETE',
    /** El enlace abierto también aquí: si estuviera solo en la búsqueda normal,
     *  el mismo artículo tendría dónde leerse o no según por qué pestaña se
     *  llegó a él, que no hay forma de explicarle a nadie. */
    resultados: await enlaceAbierto.pegarALosResultados(
      ordenados.map((r) => ({ ...r, yaLaTienes: yaLasTiene.has(identidadDe(r)) })),
    ),
  };
}

module.exports = {
  empezar,
  terminar,
  buscar,
  cuentas,
  buscarSemantica,
  opcionesDeLaFaceta,
  importar,
  estado,
  desconectar,
  urlDelPanel,
  MAXIMO_POR_IMPORTACION,
};
