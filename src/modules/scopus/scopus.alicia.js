'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const { generarConRespaldo, modelosDeTexto } = require('../../lib/gemini');
const alicia = require('../references/alicia.client');
const lareferencia = require('../references/lareferencia.client');
const { normalizar } = require('../references/zotero.mapper');
const propiasRepository = require('../references/propias.repository');

/**
 * LO MISMO QUE BUSCÓ EN SCOPUS, EN LAS TESIS Y REVISTAS PERUANAS.
 *
 * Cuando el tesista busca en Scopus, la web pide también esto con la misma
 * ecuación, y enseña lo que encuentra ALICIA en un bloque aparte debajo de la
 * tabla. No es otra búsqueda que tenga que escribir: es la suya, llevada al
 * repositorio nacional, que es de donde salen los antecedentes nacionales.
 *
 * DOS COSAS HAY QUE CAMBIARLE A LA ECUACIÓN
 * -----------------------------------------
 * 1. Los campos. `TITLE-ABS-KEY(...)` no existe en ALICIA: se quedan las
 *    palabras y la estructura de AND, OR y paréntesis. Lo que no es texto
 *    —tipo de documento, área, país, revista, autor— se cae, porque en ALICIA
 *    no significa nada. Los años sí se aprovechan, como filtro.
 * 2. El idioma. La ecuación está en inglés, porque Scopus está en inglés, y
 *    las tesis peruanas están en español. Buscar «critical thinking» AND
 *    «university students» da 39; con la traducción al lado, 334. Cada término
 *    se busca en los dos idiomas: `("critical thinking" OR "pensamiento
 *    crítico")`, y así lo que tenga el resumen en inglés tampoco se pierde.
 *
 * La traducción la hace el modelo del asistente, término a término y con
 * memoria. Si no contesta, se busca con los términos tal como están: sale
 * menos, pero sale.
 */

// ── De la ecuación de Scopus a la de ALICIA ────────────────────────────────

/** Los campos de Scopus que son texto. Los demás no tienen sentido aquí. */
const CAMPOS_DE_TEXTO = new Set(['TITLE-ABS-KEY', 'TITLE-ABS', 'TITLE', 'ABS', 'KEY', 'AUTHKEY', 'ALL']);

/** Las piezas de la ecuación, en orden. */
function piezas(ecuacion) {
  const patron =
    /"[^"]*"|\{[^}]*\}|\(|\)|\bAND\s+NOT\b|\bAND\b|\bOR\b|\b(?:W|PRE)\/\d+\b|[<>]=?|=|[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9](?=\s*\()|[^\s(){}"]+/g;
  return String(ecuacion ?? '').match(patron) ?? [];
}

const esOperador = (p) => /^(AND(\s+NOT)?|OR|(W|PRE)\/\d+)$/.test(p);
// Scopus admite los campos en minúsculas («title-abs-key(...)»), y hay quien
// los pega así.
const esCampo = (p, siguiente) => siguiente === '(' && /^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/.test(p);

/**
 * Lee la ecuación a un árbol pequeño: grupos de partes unidas por operadores,
 * y términos. Lo que no es texto vuelve como `null`, y los años se anotan.
 *
 * No pretende entender todo el lenguaje de Scopus —para eso está Scopus—,
 * solo sacar las palabras sin romper la estructura. Ante algo que no espera,
 * lo trata como palabra: lo peor que pasa es buscar una palabra de más.
 */
function leer(ecuacion) {
  const lista = piezas(ecuacion);
  const anios = { desde: null, hasta: null };
  let i = 0;

  function grupo(hasta) {
    const partes = [];
    let operador = null;
    let palabras = [];

    const cerrarPalabras = () => {
      if (palabras.length) {
        partes.push({ operador, nodo: { termino: palabras.join(' '), frase: false } });
        operador = null;
        palabras = [];
      }
    };

    while (i < lista.length && lista[i] !== hasta) {
      const p = lista[i];

      if (esOperador(p)) {
        cerrarPalabras();
        // La proximidad (W/3) no existe en ALICIA: lo más parecido es AND.
        operador = p.startsWith('AND') || p === 'OR' ? p.replace(/\s+/, ' ') : 'AND';
        i += 1;
        continue;
      }

      if (p === '(') {
        cerrarPalabras();
        i += 1;
        const dentro = grupo(')');
        i += 1;
        partes.push({ operador, nodo: dentro });
        operador = null;
        continue;
      }

      if (esCampo(p, lista[i + 1])) {
        cerrarPalabras();
        i += 2;
        const dentro = grupo(')');
        i += 1;
        partes.push({ operador, nodo: CAMPOS_DE_TEXTO.has(p.toUpperCase()) ? dentro : null });
        operador = null;
        continue;
      }

      // `PUBYEAR > 2019`: no es texto, pero dice qué años quiere.
      if (p.toUpperCase() === 'PUBYEAR' &&/^[<>=]/.test(lista[i + 1] ?? '')) {
        cerrarPalabras();
        const signo = lista[i + 1];
        const anio = Number.parseInt(lista[i + 2], 10);
        if (Number.isFinite(anio)) {
          if (signo === '>') anios.desde = anio + 1;
          if (signo === '>=') anios.desde = anio;
          if (signo === '<') anios.hasta = anio - 1;
          if (signo === '<=') anios.hasta = anio;
          if (signo === '=') anios.desde = anios.hasta = anio;
        }
        i += 3;
        partes.push({ operador, nodo: null });
        operador = null;
        continue;
      }

      if (/^["{]/.test(p)) {
        cerrarPalabras();
        const texto = p.slice(1, -1).trim();
        partes.push({ operador, nodo: texto ? { termino: texto, frase: true } : null });
        operador = null;
        i += 1;
        continue;
      }

      // Un signo suelto que no va con PUBYEAR no es una palabra.
      if (!/^[<>=]/.test(p) && p !== ')') palabras.push(p);
      i += 1;
    }

    cerrarPalabras();
    return { partes };
  }

  const arbol = grupo(null);
  return { arbol, anios };
}

/** Los términos del árbol, sin repetir, para traducirlos de una vez. */
function terminosDe(nodo, lista = new Set()) {
  if (!nodo) return lista;
  if (nodo.termino) lista.add(nodo.termino);
  for (const parte of nodo.partes ?? []) terminosDe(parte.nodo, lista);
  return lista;
}

/** Sin tildes ni mayúsculas, para ver si la traducción es la misma palabra. */
const plano = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\*/g, '')
    .toLowerCase()
    .trim();

/** Comillas fuera: dentro de una frase de ALICIA romperían la consulta. */
const comoFrase = (texto) => `"${String(texto).replace(/["\\]/g, ' ').trim()}"`;

function escribir(nodo, traducciones) {
  if (!nodo) return '';

  if (nodo.termino) {
    const original = nodo.frase
      ? comoFrase(nodo.termino)
      : nodo.termino.includes(' ')
        ? `(${nodo.termino.split(/\s+/).join(' AND ')})`
        : nodo.termino;
    const traduccion = traducciones.get(nodo.termino);
    return traduccion && plano(traduccion) !== plano(nodo.termino)
      ? `(${original} OR ${comoFrase(traduccion)})`
      : original;
  }

  const escritas = [];
  for (const { operador, nodo: hijo } of nodo.partes) {
    const texto = escribir(hijo, traducciones);
    if (!texto) continue;
    // Si lo que quedó primero era un «AND NOT x», quitar lo de delante lo
    // convertiría en un «x» a secas: buscaría justo lo que quería excluir.
    if (escritas.length === 0 && operador === 'AND NOT') continue;
    escritas.push(escritas.length === 0 ? texto : `${operador ?? 'AND'} ${texto}`);
  }

  if (escritas.length === 0) return '';
  return escritas.length === 1 ? escritas[0] : `(${escritas.join(' ')})`;
}

// ── La traducción ─────────────────────────────────────────────────────────

/**
 * Lo ya traducido. Los términos se repiten mucho —«university students»,
 * «academic performance»— entre tesistas y entre búsquedas del mismo, y cada
 * traducción es una llamada al modelo. En memoria y con techo: si se reinicia
 * el servidor se vuelve a pedir, que no es grave.
 */
const memoria = new Map();
const TOPE_DE_MEMORIA = 5000;

const SISTEMA = `Traduces términos de búsqueda académica del inglés al español, tal como los escribiría un tesista peruano en el título de su tesis.
Recibes un JSON con una lista de términos y devuelves SOLO un JSON {"traducciones":["...", "..."]} con la traducción de cada uno, en el mismo orden y la misma cantidad.
Reglas: traducción técnica y habitual en la literatura hispana (critical thinking → pensamiento crítico; university students → estudiantes universitarios; job satisfaction → satisfacción laboral). Sin comillas ni comodines. Si un término ya está en español, o es un nombre propio o una sigla (ChatGPT, PLS-SEM), devuélvelo igual. Si lleva comodín (teach*), tradúcelo sin él (enseñanza).`;

async function traducir(terminos, { generar = generarConRespaldo } = {}) {
  const traducciones = new Map();
  const faltan = [];
  for (const termino of terminos) {
    if (memoria.has(termino)) traducciones.set(termino, memoria.get(termino));
    else faltan.push(termino);
  }

  if (faltan.length === 0 || !env.asistenteEnabled) return traducciones;

  try {
    const { texto } = await generar({
      modelos: modelosDeTexto(),
      sistema: SISTEMA,
      mensajes: [{ rol: 'usuario', texto: JSON.stringify({ terminos: faltan }) }],
      maxTokens: 600,
      timeoutMs: 10_000,
      ventajaMs: 3_000,
      json: true,
    });
    const lista = JSON.parse(texto.match(/\{[\s\S]*\}/)?.[0] ?? '{}').traducciones;

    if (Array.isArray(lista) && lista.length === faltan.length) {
      faltan.forEach((termino, j) => {
        const traduccion = String(lista[j] ?? '').replace(/["*]/g, '').trim().slice(0, 120);
        if (!traduccion) return;
        traducciones.set(termino, traduccion);
        if (memoria.size >= TOPE_DE_MEMORIA) memoria.delete(memoria.keys().next().value);
        memoria.set(termino, traduccion);
      });
    }
  } catch (fallo) {
    // Sin traducción se busca igual, con los términos como están.
    logger.warn({ err: fallo.message }, 'ALICIA: no se pudieron traducir los términos');
  }

  return traducciones;
}

/**
 * La ecuación de Scopus, como consulta de ALICIA. `generar` existe para las
 * pruebas.
 */
async function consultaParaAlicia(ecuacion, opciones = {}) {
  const { arbol, anios } = leer(ecuacion);
  const terminos = [...terminosDe(arbol)].slice(0, 30);
  const traducciones = terminos.length ? await traducir(terminos, opciones) : new Map();

  return { consulta: escribir(arbol, traducciones).slice(0, 1500), ...anios };
}

// ── Lo que pide la web ─────────────────────────────────────────────────────

const noResponde = (mensaje = 'El repositorio ALICIA no responde ahora. Prueba en unos minutos.') =>
  new AppError(mensaje, { statusCode: 503, code: ERROR_CODES.ASSISTANT_UNAVAILABLE });

/**
 * DE DÓNDE SALE LA LISTA: ALICIA, LO GUARDADO O LA REFERENCIA
 * ----------------------------------------------------------
 * ALICIA es la buena: tiene las tesis de pregrado, el asesor y la revista. Pero
 * es un servidor del Estado y el 9 y el 10-oct-2026 pasó de lenta a caída y de
 * caída a lenta otra vez: contestaba, pero en 16 a 31 segundos. Con «contesta o
 * no contesta» no bastaba —el tesista esperaba medio minuto cada vez que el
 * sondeo la daba por buena—, así que lo que se mide es si contesta A TIEMPO:
 *
 * 1. LO GUARDADO. Lo que ALICIA ya contestó vale media hora como recién
 *    pedido: volver de la página 2 a la 1, quitar un filtro, o el tesista de al
 *    lado con el mismo tema. Y pasado ese tiempo sigue sirviendo si ALICIA no
 *    contesta: mejor su lista de hace un rato que la de otro catálogo.
 * 2. SEIS SEGUNDOS DE PACIENCIA. Se le pregunta a ALICIA y se la espera eso.
 *    Si no llegó, el tesista ve ya lo de LA Referencia (el nodo peruano, que
 *    cosecha a la propia ALICIA y contesta en un segundo; sin pregrado, ver
 *    `lareferencia.client`) y la pregunta a ALICIA SIGUE VIVA por detrás.
 *    Cuando llega se guarda, y la web —que se quedó esperándola con
 *    `esperar`— cambia la lista sola.
 * 3. LENTA. Desde que ALICIA se pasa de los seis segundos, las búsquedas
 *    siguientes ni la esperan: respaldo al momento y ALICIA por detrás. Deja
 *    de estar lenta cuando una respuesta suya llega a tiempo.
 * 4. CAÍDA. Un fallo suelto no la da por caída: el 11-oct fallaba una de cada
 *    tres («Problem connecting to Solr») y contestaba las otras dos en 20 a
 *    35 s, y con un solo fallo todo el mundo se quedaba tres minutos sin
 *    ALICIA, una y otra vez. Un fallo la deja en LENTA; solo TRES SEGUIDOS son
 *    una caída, y entonces sí: no se le pregunta en cada búsqueda, solo cada
 *    tres minutos, por detrás. Cuando contesta, vuelve.
 *
 * Solo hay un caso en que el tesista espera a ALICIA lo que tarde: cuando
 * filtra SOLO pregrado, que no está en ningún otro sitio.
 *
 * LOS AVISOS SE QUEDAN. Cada vez que ALICIA falla de verdad —la primera vez y
 * en cada sondeo— se anota como error, y eso llega al móvil del administrador
 * aunque el tesista haya visto resultados. Es a propósito: es como se entera.
 * Que vaya lenta y acabe contestando no es un fallo y no avisa.
 */
const respuestas = new Map();
const RESPUESTA_FRESCA_MS = 30 * 60 * 1000;
const TOPE_DE_RESPUESTAS = 300;
const SONDEAR_CADA_MS = 3 * 60 * 1000;

/** Lo que se espera a ALICIA antes de enseñar el respaldo. */
const PACIENCIA_MS = 6_000;
/** Por detrás no espera nadie: se le da más que los 30 s de siempre. */
const TIEMPO_POR_DETRAS_MS = 45_000;
/** Preguntas a la vez mientras va lenta: no se le echa más carga encima. */
const MAXIMO_EN_CAMINO = 4;

/** Fallos seguidos para darla por caída. */
const FALLOS_PARA_CAIDA = 3;

const estado = { fallando: false, lenta: false, fallosSeguidos: 0, proximoSondeo: 0 };

/** Las preguntas a ALICIA que no han vuelto, por búsqueda: `{ promesa, desde }`. */
const enCamino = new Map();

/**
 * Las fichas que ya se enseñaron, por identificador. «Añadir a mis fuentes»
 * las toma de aquí en vez de volver a pedírselas al repositorio: sale al
 * momento y no depende de que ALICIA siga contestando un minuto después. Son
 * las que mandó el repositorio, no las que diga el navegador.
 */
const fichasVistas = new Map();
const TOPE_DE_FICHAS = 3000;

function recordarFichas(fichas) {
  for (const ficha of fichas) {
    fichasVistas.delete(ficha.id);
    if (fichasVistas.size >= TOPE_DE_FICHAS) fichasVistas.delete(fichasVistas.keys().next().value);
    fichasVistas.set(ficha.id, ficha);
  }
}

/** Para las pruebas: como recién arrancado. */
function reiniciar() {
  respuestas.clear();
  fichasVistas.clear();
  enCamino.clear();
  Object.assign(estado, { fallando: false, lenta: false, fallosSeguidos: 0, proximoSondeo: 0 });
}

function guardar(clave, respuesta, en) {
  respuestas.delete(clave);
  if (respuestas.size >= TOPE_DE_RESPUESTAS) respuestas.delete(respuestas.keys().next().value);
  respuestas.set(clave, { en, respuesta });
  recordarFichas(respuesta.fichas ?? []);
}

/** La misma búsqueda, se pida como se pida. */
const claveDe = ({ consulta, desde = null, hasta = null, pagina = 1, tipos = [] }) =>
  JSON.stringify([consulta, desde ?? null, hasta ?? null, pagina, [...tipos].sort()]);

/** Un solo intento: si falla, hay a dónde ir. */
const unaVezEnAlicia = (peticion) =>
  alicia.buscar(peticion, { reintentar: false, tiempoMs: TIEMPO_POR_DETRAS_MS });

/**
 * Le pregunta a ALICIA, o se suma a la pregunta igual que ya iba de camino.
 * La promesa nunca falla: da la respuesta, o `null` si ALICIA no contestó. Es
 * ella la que guarda lo que llega y la que lleva la cuenta de cómo está
 * ALICIA, espere alguien o no.
 */
function preguntar(peticion, clave, { enAlicia, ahora, pacienciaMs }) {
  const yaIba = enCamino.get(clave);
  if (yaIba) return yaIba;

  const desde = ahora();
  const pedido = { promesa: null, desde };

  // `async` para que un fallo al armar la petición también sea un «no contestó».
  pedido.promesa = (async () => enAlicia(peticion))()
    .then(
      (respuesta) => {
        guardar(clave, respuesta, ahora());
        if (estado.fallando) logger.info('ALICIA volvió a responder');
        estado.fallando = false;
        estado.fallosSeguidos = 0;
        estado.lenta = ahora() - desde > pacienciaMs;
        return respuesta;
      },
      (fallo) => {
        logger.error(
          { err: fallo.message },
          estado.fallando
            ? 'ALICIA sigue sin responder: se busca en LA Referencia'
            : 'ALICIA no responde: se busca en LA Referencia',
        );
        // Falle como falle, la siguiente búsqueda no se queda esperándola.
        estado.lenta = true;
        estado.fallosSeguidos += 1;
        if (estado.fallosSeguidos >= FALLOS_PARA_CAIDA) {
          estado.fallando = true;
          estado.proximoSondeo = ahora() + SONDEAR_CADA_MS;
        }
        return null;
      },
    )
    .finally(() => {
      if (enCamino.get(clave) === pedido) enCamino.delete(clave);
    });

  enCamino.set(clave, pedido);
  return pedido;
}

const TARDA = Symbol('tarda');

/** La respuesta, o `TARDA` si no llegó en `ms`. */
async function conPaciencia(promesa, ms) {
  if (ms <= 0) return TARDA;
  let reloj;
  const tope = new Promise((listo) => {
    reloj = setTimeout(() => listo(TARDA), ms);
  });
  try {
    return await Promise.race([promesa, tope]);
  } finally {
    clearTimeout(reloj);
  }
}

const SOLO_PREGRADO =
  'ALICIA no responde ahora, y las tesis de pregrado solo están ahí. Prueba en unos minutos o quita ese filtro.';

async function desdeElRespaldo(peticion, enRespaldo) {
  const tipos = peticion.tipos ?? [];
  const losQueTiene = tipos.filter((tipo) => lareferencia.TIPOS[tipo]);
  if (tipos.length > 0 && losQueTiene.length === 0) throw noResponde(SOLO_PREGRADO);

  try {
    const respuesta = await enRespaldo({ ...peticion, tipos: losQueTiene });
    recordarFichas(respuesta.fichas ?? []);
    return { ...respuesta, fuente: 'lareferencia' };
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'LA Referencia tampoco contestó');
    throw noResponde();
  }
}

/**
 * La lista de tesis y revistas peruanas, venga de donde venga. Devuelve lo de
 * `alicia.client.buscar` más `fuente` (`alicia` o `lareferencia`) y
 * `aliciaEnCamino`: la lista no es la de ALICIA de ahora, pero se le preguntó
 * y puede llegar (ver `loQueTraigaAlicia`).
 */
async function buscarEnPeruanas(
  peticion,
  {
    enAlicia = unaVezEnAlicia,
    enRespaldo = lareferencia.buscar,
    ahora = Date.now,
    pacienciaMs = PACIENCIA_MS,
  } = {},
) {
  const clave = claveDe(peticion);
  const tipos = peticion.tipos ?? [];

  const guardada = respuestas.get(clave);
  if (guardada && ahora() - guardada.en < RESPUESTA_FRESCA_MS) {
    return { ...guardada.respuesta, fuente: 'alicia', aliciaEnCamino: false };
  }

  // Lo que pide no está en el respaldo: a ALICIA se la espera lo que tarde.
  const soloEnAlicia = tipos.length > 0 && !tipos.some((tipo) => lareferencia.TIPOS[tipo]);
  // Cómo estaba antes de esta búsqueda: de eso depende cuánto se la espera.
  const { fallando, lenta } = estado;

  let pedido = enCamino.get(clave) ?? null;
  if (!pedido) {
    const toca = fallando
      ? ahora() >= estado.proximoSondeo
      : !lenta || soloEnAlicia || enCamino.size < MAXIMO_EN_CAMINO;
    if (toca) {
      // Caída: el siguiente sondeo, dentro de tres minutos, salga este como salga.
      if (fallando) estado.proximoSondeo = ahora() + SONDEAR_CADA_MS;
      pedido = preguntar(peticion, clave, { enAlicia, ahora, pacienciaMs });
    }
  }

  let fallo = false;
  if (pedido) {
    let respuesta;
    if (soloEnAlicia) respuesta = await pedido.promesa;
    else if (fallando || lenta) respuesta = TARDA;
    else respuesta = await conPaciencia(pedido.promesa, pacienciaMs - (ahora() - pedido.desde));

    if (respuesta === TARDA) estado.lenta = estado.lenta || !fallando;
    else if (respuesta) return { ...respuesta, fuente: 'alicia', aliciaEnCamino: false };
    else fallo = true;
  }

  const aliciaEnCamino = Boolean(pedido) && !fallo;
  if (guardada) return { ...guardada.respuesta, fuente: 'alicia', aliciaEnCamino };
  return { ...(await desdeElRespaldo(peticion, enRespaldo)), aliciaEnCamino };
}

/**
 * Lo que ALICIA acabe contestando a una búsqueda que se enseñó con el respaldo.
 * Es la segunda petición de la web, la que se queda esperando: la respuesta de
 * ALICIA si llega (o si ya llegó), y `null` si falló o si nadie le preguntó.
 */
async function loQueTraigaAlicia(peticion, { ahora = Date.now } = {}) {
  const clave = claveDe(peticion);
  const fresca = () => {
    const guardada = respuestas.get(clave);
    return guardada && ahora() - guardada.en < RESPUESTA_FRESCA_MS ? guardada.respuesta : null;
  };

  const pedido = enCamino.get(clave);
  return fresca() ?? (pedido ? await pedido.promesa : null);
}

/**
 * Por dónde entró: `alicia:UPAO_…` o `lareferencia:PE_…`. Los de LA Referencia
 * ya traen su prefijo.
 */
const sourceRefDe = (id) =>
  (String(id).startsWith(lareferencia.PREFIJO) ? String(id) : `alicia:${id}`).slice(0, 200);

/**
 * Lo que los dos catálogos tienen en común: el hash del final. Es el mismo
 * registro en `UPAO_820c…` y en `PE_820c…`, y con él se sabe que el tesista
 * ya tiene una tesis aunque la guardara desde el otro sitio.
 */
const hashDe = (id) => String(id).slice(String(id).lastIndexOf('_') + 1);

/**
 * Busca. Con `consulta`, la que el tesista corrigió a mano en el bloque; sin
 * ella, la que sale de su ecuación de Scopus.
 *
 * Con `esperar` no busca: se queda a la espera de lo que ALICIA conteste a la
 * búsqueda que se acaba de enseñar con el respaldo (la web manda la `consulta`
 * que recibió, para que sea la misma). Devuelve la lista de ALICIA con
 * `llego: true`, o solo `llego: false` si al final no contestó.
 */
async function buscar(
  userId,
  { ecuacion, consulta, pagina = 1, tipos = [], desde, hasta, esperar = false },
) {
  let armada;
  if (consulta) {
    armada = { consulta, desde: desde ?? null, hasta: hasta ?? null };
  } else {
    armada = await consultaParaAlicia(ecuacion);
  }

  if (!armada.consulta) {
    return { consulta: '', total: 0, pagina: 1, paginas: 1, porPagina: alicia.POR_PAGINA, resultados: [] };
  }

  let respuesta;
  if (esperar) {
    const deAlicia = await loQueTraigaAlicia({ ...armada, pagina, tipos });
    if (!deAlicia) return { llego: false };
    respuesta = { ...deAlicia, fuente: 'alicia', aliciaEnCamino: false };
  } else {
    respuesta = await buscarEnPeruanas({ ...armada, pagina, tipos });
  }

  const tiene = new Set(
    await propiasRepository.hashesDeRepositorioQueTiene(
      userId,
      respuesta.fichas.map((f) => hashDe(f.id)),
    ),
  );

  return {
    consulta: armada.consulta,
    desde: armada.desde,
    hasta: armada.hasta,
    // `alicia` o `lareferencia`: la web avisa cuando es el respaldo.
    fuente: respuesta.fuente,
    // La lista no es la de ALICIA de ahora, pero puede llegar: la web la espera.
    aliciaEnCamino: respuesta.aliciaEnCamino,
    ...(esperar ? { llego: true } : {}),
    total: respuesta.total,
    pagina,
    // VuFind no pasa de la página 500, y nadie llega ahí; se acota igual.
    paginas: Math.max(1, Math.min(Math.ceil(respuesta.total / alicia.POR_PAGINA), 50)),
    porPagina: alicia.POR_PAGINA,
    resultados: respuesta.fichas.map((ficha) => ({
      id: ficha.id,
      titulo: ficha.title,
      autores: ficha.authors,
      anio: ficha.year,
      tipo: ficha.tipo,
      universidad: ficha.universidad,
      // LA Referencia no trae la revista y en su sitio queda la universidad.
      revista:
        ficha.formato === 'article' && ficha.source !== ficha.universidad ? ficha.source : null,
      asesor: ficha.asesor,
      url: ficha.url,
      resumen: ficha.abstract,
      yaLaTienes: tiene.has(hashDe(ficha.id)),
    })),
  };
}

/** Cuántos de una vez: una página. */
const MAXIMO_POR_IMPORTACION = alicia.POR_PAGINA;

/** De la ficha de ALICIA a la fila de `references`, como las demás. */
function comoFila(ficha) {
  const recortar = (valor, largo) => {
    const texto = String(valor ?? '').trim();
    return texto ? texto.slice(0, largo) : null;
  };

  const fila = {
    zoteroKey: null,
    version: 0,
    // SCOPUS, como lo que entra por DOI o por SciELO: «una fuente que subió
    // el comprador». Un valor propio pediría una migración y el tesista no
    // necesita filtrar por él.
    origin: 'SCOPUS',
    sourceRef: sourceRefDe(ficha.id),
    itemType: recortar(ficha.itemType, 40) ?? 'thesis',
    title: recortar(ficha.title, 500) ?? '(sin título)',
    authors: recortar(ficha.authors, 500) ?? '',
    year: ficha.year ?? null,
    source: recortar(ficha.source, 300),
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    url: recortar(ficha.url, 500),
    abstract: ficha.abstract || null,
    notes: null,
    tags: recortar(ficha.tags, 500) ?? '',
  };

  fila.busqueda = normalizar(
    [fila.title, fila.authors, fila.source, fila.year, fila.abstract, fila.tags]
      .filter(Boolean)
      .join(' '),
  );
  return fila;
}

/**
 * Guarda lo que marcó. Llegan identificadores y la ficha se vuelve a pedir a
 * ALICIA: lo que entra en su biblioteca es lo que dice el repositorio, no lo
 * que diga una petición del navegador. Mismo criterio que con Scopus.
 */
async function importar(
  userId,
  { ids },
  { pedirFichas = { alicia: alicia.porIds, lareferencia: lareferencia.porIds } } = {},
) {
  const lista = [...new Set((ids ?? []).map((id) => String(id).trim()))].filter(
    (id) => alicia.esId(id) || lareferencia.esId(id),
  );

  if (lista.length === 0) throw new ValidationError('No marcaste ninguna tesis ni artículo.');
  if (lista.length > MAXIMO_POR_IMPORTACION) {
    throw new ValidationError(`Puedes guardar hasta ${MAXIMO_POR_IMPORTACION} de una vez.`);
  }

  const tiene = await propiasRepository.contar(userId);
  if (tiene + lista.length > propiasRepository.TOPE_POR_USUARIO) {
    throw new AppError(
      `Tu biblioteca admite ${propiasRepository.TOPE_POR_USUARIO} fuentes y con esas pasarías ` +
        `de ahí (tienes ${tiene}).`,
      { statusCode: 409, code: ERROR_CODES.VALIDATION_ERROR },
    );
  }

  // Primero las que ya se enseñaron; al repositorio solo las que falten (el
  // servidor se reinició, o pasó mucho rato desde la búsqueda).
  const fichas = lista.map((id) => fichasVistas.get(id)).filter(Boolean);
  const faltan = lista.filter((id) => !fichasVistas.has(id));

  if (faltan.length > 0) {
    try {
      const deAlicia = faltan.filter(alicia.esId);
      const deLaReferencia = faltan.filter(lareferencia.esId);
      if (deAlicia.length > 0) fichas.push(...(await pedirFichas.alicia(deAlicia)));
      if (deLaReferencia.length > 0) fichas.push(...(await pedirFichas.lareferencia(deLaReferencia)));
    } catch (fallo) {
      logger.warn({ err: fallo.message }, 'ALICIA: no se pudieron pedir las fichas');
      // Con las que sí hay se sigue; sin ninguna, no hay nada que guardar.
      if (fichas.length === 0) throw noResponde();
    }
  }

  if (fichas.length === 0) {
    throw new ValidationError('El repositorio ya no devuelve esas fichas. Vuelve a buscar y márcalas otra vez.');
  }

  // Las que ya tiene, aunque entraran por el otro catálogo, no se repiten.
  const yaTiene = new Set(
    await propiasRepository.hashesDeRepositorioQueTiene(
      userId,
      fichas.map((ficha) => hashDe(ficha.id)),
    ),
  );
  const filas = fichas.filter((ficha) => !yaTiene.has(hashDe(ficha.id))).map(comoFila);
  const lote = await propiasRepository.guardarLote(userId, filas);
  const guardadas = lote.guardadas;
  const repetidas = lote.repetidas + (fichas.length - filas.length);
  logger.info({ userId, pedidas: lista.length, guardadas, repetidas }, 'Fuentes importadas desde ALICIA');

  return {
    pedidas: lista.length,
    guardadas,
    repetidas,
    noEncontradas: lista.length - fichas.length,
    sinResumen: filas.filter((fila) => !fila.abstract).length,
    total: tiene + guardadas,
  };
}

module.exports = {
  buscar,
  importar,
  consultaParaAlicia,
  buscarEnPeruanas,
  loQueTraigaAlicia,
  reiniciar,
  leer,
  comoFila,
  MAXIMO_POR_IMPORTACION,
};
