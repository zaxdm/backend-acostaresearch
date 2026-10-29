'use strict';

/**
 * Semantic Scholar (Allen Institute for AI): unos 220 millones de artículos de
 * todas las áreas, con resumen y, muchas veces, el PDF abierto.
 *
 * Sin clave funciona, pero con un cupo que comparten TODOS los que llaman sin
 * clave en el mundo, y el 429 es frecuente: por eso se reintenta una vez. Con
 * `SEMANTIC_SCHOLAR_API_KEY` en el `.env` el cupo es propio (1 petición/s).
 *
 * La búsqueda por relevancia (`/paper/search`) no entiende AND/OR: va con
 * `palabras`. La que sí los entiende (`/paper/search/bulk`) no ordena por
 * relevancia ni pagina por número, y para un tesista lo primero es lo útil.
 */

const comun = require('./comun');

const API = 'https://api.semanticscholar.org/graph/v1';

const CAMPOS = [
  'paperId',
  'externalIds',
  'title',
  'authors',
  'year',
  'venue',
  'journal',
  'abstract',
  'citationCount',
  'url',
  'openAccessPdf',
  'publicationTypes',
].join(',');

/** El id de Semantic Scholar: 40 caracteres hexadecimales. */
const ID_VALIDO = /^[0-9a-f]{40}$/i;

/** La relevancia de Semantic Scholar no pasa del resultado 1.000. */
const TOPE_RELEVANCIA = 1000;

const ESPERA_429_MS = 1200;

/** Se puede cambiar en las pruebas para no esperar de verdad. */
const reloj = { esperar: (ms) => new Promise((r) => setTimeout(r, ms)) };

function cabeceras() {
  const k = comun.clave('SEMANTIC_SCHOLAR_API_KEY');
  return k ? { 'x-api-key': k } : {};
}

/** `comun.pedir` con un reintento si el cupo compartido contesta 429. */
async function pedirConReintento(url) {
  const res = await comun.pedir(url, { base: 'Semantic Scholar', headers: cabeceras() });
  if (res?.status !== 429) return res;
  await reloj.esperar(ESPERA_429_MS);
  return comun.pedir(url, { base: 'Semantic Scholar', headers: cabeceras() });
}

/** El `tipo` del contrato a partir de `publicationTypes`, que a veces viene vacío. */
function tipoDe(p) {
  const tipos = p.publicationTypes ?? [];
  if (tipos.includes('Review') || tipos.includes('MetaAnalysis')) return 'review';
  if (tipos.includes('JournalArticle')) return 'article';
  if (tipos.includes('BookSection')) return 'chapter';
  if (tipos.includes('Book')) return 'book';
  if (tipos.includes('Conference')) return 'other';
  // Sin tipo: lo que solo está en arXiv es un preprint; lo que tiene revista, un artículo.
  if (p.externalIds?.ArXiv && !p.journal?.name) return 'preprint';
  return p.journal?.name ? 'article' : 'other';
}

const ITEM_TYPE = {
  article: 'journalArticle',
  review: 'journalArticle',
  preprint: 'preprint',
  book: 'book',
  chapter: 'bookSection',
  dissertation: 'thesis',
  other: 'document',
};

function nombres(p) {
  return (p.authors ?? []).map((a) => a?.name);
}

function revistaDe(p) {
  return comun.textoLimpio(p.journal?.name) ?? comun.textoLimpio(p.venue);
}

function comoResultado(p) {
  const doi = comun.limpiarDoi(p.externalIds?.DOI);
  return {
    id: p.paperId,
    doi,
    titulo: comun.textoLimpio(p.title) ?? '(sin título)',
    autores: comun.autoresApa(nombres(p)),
    anio: comun.anioDe(p.year),
    revista: revistaDe(p),
    idioma: null,
    citas: p.citationCount ?? 0,
    enlace: p.url ?? (doi ? `https://doi.org/${doi}` : null),
    pdfLibre: p.openAccessPdf?.url || null,
    resumen: comun.textoLimpio(p.abstract),
    tipo: tipoDe(p),
  };
}

function comoFicha(p) {
  const doi = comun.limpiarDoi(p.externalIds?.DOI);
  return {
    id: p.paperId,
    doi,
    title: comun.textoLimpio(p.title) ?? '(sin título)',
    authors: comun.autoresApa(nombres(p)),
    year: comun.anioDe(p.year),
    source: revistaDe(p),
    volume: String(p.journal?.volume ?? '').trim() || null,
    issue: null,
    pages: String(p.journal?.pages ?? '').trim() || null,
    url: p.url ?? (doi ? `https://doi.org/${doi}` : null),
    abstract: comun.textoLimpio(p.abstract),
    itemType: ITEM_TYPE[tipoDe(p)],
  };
}

/** «2019-2023», «2019-» o «-2023», como lo pide la API; null sin años. */
function rangoDeAnios(desde, hasta) {
  if (!desde && !hasta) return null;
  return `${desde ?? ''}-${hasta ?? ''}`;
}

async function buscar({ palabras, consulta, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  // Si solo llegó la booleana, se le quitan los operadores: aquí serían palabras.
  const texto = String(palabras || consulta || '')
    .replace(/["()]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!texto) return comun.CAIDA;

  const limite = Math.min(Math.max(Number(porPagina) || 25, 1), 100);
  const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;
  // Más allá del 1.000 la API contesta 400: no hay más páginas que pedir.
  if (offset + limite > TOPE_RELEVANCIA) return { resultados: [], total: TOPE_RELEVANCIA, caida: false };

  const url = new URL(`${API}/paper/search`);
  url.searchParams.set('query', texto);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limite));
  url.searchParams.set('fields', CAMPOS);
  const anios = rangoDeAnios(desde, hasta);
  if (anios) url.searchParams.set('year', anios);

  const res = await pedirConReintento(url);
  if (!res?.ok) return comun.CAIDA;

  const resultados = (res.json.data ?? []).filter((p) => p?.paperId).map(comoResultado);
  return { resultados, total: Number(res.json.total) || resultados.length, caida: false };
}

/**
 * Una petición por id y en fila: sin clave, pedirlas a la vez solo gasta el
 * cupo compartido en 429.
 */
async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))].filter((i) => ID_VALIDO.test(i)).slice(0, 25);
  const fichas = [];
  for (const id of validos) {
    const url = new URL(`${API}/paper/${id}`);
    url.searchParams.set('fields', CAMPOS);
    const res = await pedirConReintento(url);
    if (res?.ok && res.json?.paperId) fichas.push(comoFicha(res.json));
  }
  return fichas;
}

module.exports = {
  clave: 'semanticscholar',
  nombre: 'Semantic Scholar',
  detalle: 'Todas las áreas, con resumen y PDF abierto',
  // Sin clave el cupo es el compartido de todo el mundo, y el 28-oct-2026 daba
  // 429 en cada intento: mejor no ofrecerla que ofrecer un error.
  activa: () => Boolean(comun.clave('SEMANTIC_SCHOLAR_API_KEY')),
  buscar,
  porIds,
  _reloj: reloj,
};
