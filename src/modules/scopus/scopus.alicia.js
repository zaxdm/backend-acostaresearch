'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError, ValidationError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const { generarConRespaldo, modelosDeTexto } = require('../../lib/gemini');
const alicia = require('../references/alicia.client');
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

const noResponde = () =>
  new AppError('El repositorio ALICIA no responde ahora. Prueba en unos minutos.', {
    statusCode: 503,
    code: ERROR_CODES.ASSISTANT_UNAVAILABLE,
  });

/**
 * Lo que ALICIA ya contestó. Cuando va lenta tarda veinte segundos por
 * página, y la misma búsqueda se repite: al volver de la página 2 a la 1, al
 * quitar un filtro, o entre tesistas del mismo tema. Media hora vale como
 * recién pedido; pasado ese tiempo se vuelve a pedir, pero lo guardado se
 * sigue enseñando si ALICIA no contesta: mejor una lista de hace un rato que
 * un «no responde».
 */
const respuestas = new Map();
const RESPUESTA_FRESCA_MS = 30 * 60 * 1000;
const TOPE_DE_RESPUESTAS = 300;

async function buscarConMemoria(peticion, { buscarEnAlicia = alicia.buscar, ahora = Date.now } = {}) {
  const { consulta, desde = null, hasta = null, pagina = 1, tipos = [] } = peticion;
  const clave = JSON.stringify([consulta, desde, hasta, pagina, [...tipos].sort()]);

  const guardada = respuestas.get(clave);
  if (guardada && ahora() - guardada.en < RESPUESTA_FRESCA_MS) return guardada.respuesta;

  let respuesta;
  try {
    respuesta = await buscarEnAlicia(peticion);
  } catch (fallo) {
    if (!guardada) throw fallo;
    logger.warn({ err: fallo.message }, 'ALICIA: no contestó, se enseña lo guardado');
    return guardada.respuesta;
  }

  respuestas.delete(clave);
  if (respuestas.size >= TOPE_DE_RESPUESTAS) respuestas.delete(respuestas.keys().next().value);
  respuestas.set(clave, { en: ahora(), respuesta });
  return respuesta;
}

const sourceRefDe = (id) => `alicia:${id}`.slice(0, 200);

/**
 * Busca. Con `consulta`, la que el tesista corrigió a mano en el bloque; sin
 * ella, la que sale de su ecuación de Scopus.
 */
async function buscar(userId, { ecuacion, consulta, pagina = 1, tipos = [], desde, hasta }) {
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
  try {
    respuesta = await buscarConMemoria({ ...armada, pagina, tipos });
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'ALICIA: la búsqueda falló');
    throw noResponde();
  }

  const tiene = new Set(
    await propiasRepository.cualesTiene(
      userId,
      respuesta.fichas.map((f) => sourceRefDe(f.id)),
    ),
  );

  return {
    consulta: armada.consulta,
    desde: armada.desde,
    hasta: armada.hasta,
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
      revista: ficha.formato === 'article' ? ficha.source : null,
      asesor: ficha.asesor,
      url: ficha.url,
      resumen: ficha.abstract,
      yaLaTienes: tiene.has(sourceRefDe(ficha.id)),
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
async function importar(userId, { ids }) {
  const lista = [...new Set((ids ?? []).map((id) => String(id).trim()))].filter(alicia.esId);

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

  let fichas;
  try {
    fichas = await alicia.porIds(lista);
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'ALICIA: no se pudieron pedir las fichas');
    throw noResponde();
  }

  const filas = fichas.map(comoFila);
  if (filas.length === 0) {
    throw new ValidationError('ALICIA ya no devuelve esas fichas. Vuelve a buscar y márcalas otra vez.');
  }

  const { guardadas, repetidas } = await propiasRepository.guardarLote(userId, filas);
  logger.info({ userId, pedidas: lista.length, guardadas, repetidas }, 'Fuentes importadas desde ALICIA');

  return {
    pedidas: lista.length,
    guardadas,
    repetidas,
    noEncontradas: lista.length - filas.length,
    sinResumen: filas.filter((fila) => !fila.abstract).length,
    total: tiene + guardadas,
  };
}

module.exports = {
  buscar,
  importar,
  consultaParaAlicia,
  buscarConMemoria,
  leer,
  comoFila,
  MAXIMO_POR_IMPORTACION,
};
