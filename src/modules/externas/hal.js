'use strict';

/**
 * HAL: el archivo abierto de Francia (CNRS), con artículos, ponencias, tesis
 * doctorales (theses.hal.science) y bastante en español. Sin clave.
 *
 * API: https://api.archives-ouvertes.fr/search/ — Solr: `q` entiende AND/OR y
 * comillas, `fq` filtra sin afectar la relevancia, `rows`/`start` paginan y
 * `fl` pide solo los campos que usamos (la respuesta completa pesa mucho).
 * Contrato: ver `index.js`.
 */

const comun = require('./comun');

const BASE = 'https://api.archives-ouvertes.fr/search/';
const NOMBRE = 'HAL';
const MAX_IDS = 25;

/** «hal-04701470», «tel-00993425», «halshs-01234567»; la versión («v1») es opcional. */
const ID_VALIDO = /^[a-z][a-z0-9]{1,20}-\d{6,10}(v\d{1,3})?$/i;

const CAMPOS = [
  'halId_s',
  'title_s',
  'authFullName_s',
  'authLastName_s',
  'authFirstName_s',
  'producedDateY_i',
  'doiId_s',
  'journalTitle_s',
  'bookTitle_s',
  'conferenceTitle_s',
  'authorityInstitution_s',
  'volume_s',
  'issue_s',
  'page_s',
  'abstract_s',
  'fileMain_s',
  'uri_s',
  'docType_s',
  'language_s',
].join(',');

/**
 * Solo lo que se cita en una tesis. Fuera imágenes, vídeos, pósteres, mapas,
 * software, blogs y patentes, que en HAL son muchos.
 * UNDEFINED es como HAL llama a los preprints y documentos de trabajo.
 */
const DOC_TYPES = ['ART', 'COMM', 'COUV', 'OUV', 'THESE', 'HDR', 'MEM', 'REPORT', 'UNDEFINED'];

const TIPOS = {
  ART: 'article',
  COUV: 'chapter',
  OUV: 'book',
  THESE: 'dissertation',
  HDR: 'dissertation',
  MEM: 'dissertation',
  UNDEFINED: 'preprint',
};

const ITEM_TYPES = {
  article: 'journalArticle',
  dissertation: 'thesis',
  book: 'book',
  chapter: 'bookSection',
  preprint: 'preprint',
};

const primero = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * HAL separa apellido y nombre: con eso las iniciales salen exactas y no hace
 * falta adivinar dónde empieza el apellido. Si faltan, el nombre completo.
 */
function autores(doc) {
  const apellidos = doc.authLastName_s ?? [];
  const nombres = doc.authFirstName_s ?? [];
  if (apellidos.length && apellidos.length === nombres.length) {
    return comun.autoresApa(
      apellidos.map((ap, i) => {
        const iniciales = String(nombres[i] ?? '')
          .split(/[\s]+/)
          .filter(Boolean)
          .map((n) => `${n.charAt(0).toUpperCase()}.`)
          .join(' ');
        return iniciales ? `${ap}, ${iniciales}` : ap;
      }),
    );
  }
  return comun.autoresApa(doc.authFullName_s ?? []);
}

function tipoDe(doc) {
  return TIPOS[doc.docType_s] ?? 'other';
}

function fuenteDe(doc) {
  return doc.journalTitle_s ?? doc.bookTitle_s ?? doc.conferenceTitle_s ?? primero(doc.authorityInstitution_s);
}

function enlaceDe(doc) {
  return doc.uri_s ?? `https://hal.science/${doc.halId_s}`;
}

function comoResultado(doc) {
  return {
    id: doc.halId_s,
    doi: comun.limpiarDoi(doc.doiId_s),
    titulo: comun.textoLimpio(primero(doc.title_s)) ?? '(sin título)',
    autores: autores(doc),
    anio: comun.anioDe(doc.producedDateY_i),
    revista: fuenteDe(doc),
    idioma: primero(doc.language_s),
    // HAL no cuenta citas.
    citas: 0,
    enlace: enlaceDe(doc),
    // `fileMain_s` solo existe cuando el texto completo está depositado y abierto.
    pdfLibre: doc.fileMain_s ?? null,
    resumen: comun.textoLimpio(primero(doc.abstract_s)),
    tipo: tipoDe(doc),
  };
}

function comoFicha(doc) {
  return {
    id: doc.halId_s,
    doi: comun.limpiarDoi(doc.doiId_s),
    title: comun.textoLimpio(primero(doc.title_s)) ?? '(sin título)',
    authors: autores(doc),
    year: comun.anioDe(doc.producedDateY_i),
    source: fuenteDe(doc),
    volume: doc.volume_s ?? null,
    issue: primero(doc.issue_s),
    pages: doc.page_s ?? null,
    url: enlaceDe(doc),
    abstract: comun.textoLimpio(primero(doc.abstract_s)),
    itemType: ITEM_TYPES[tipoDe(doc)] ?? 'document',
  };
}

/** Pide a Solr; `fq` puede repetirse. */
function urlDe({ q, fq = [], rows, start }) {
  const url = new URL(BASE);
  url.searchParams.set('q', q);
  for (const f of fq) url.searchParams.append('fq', f);
  url.searchParams.set('wt', 'json');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('start', String(start));
  url.searchParams.set('fl', CAMPOS);
  return url;
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    const q = String(consulta || palabras || '').trim();
    if (!q) return { resultados: [], total: 0, caida: false };

    const filas = Math.min(Math.max(Number(porPagina) || 25, 1), 25);
    const fq = [`docType_s:(${DOC_TYPES.join(' OR ')})`];
    if (desde || hasta) fq.push(`producedDateY_i:[${desde || '*'} TO ${hasta || '*'}]`);

    const url = urlDe({ q, fq, rows: filas, start: (Math.max(Number(pagina) || 1, 1) - 1) * filas });
    const res = await comun.pedir(url, { base: NOMBRE });
    const docs = res?.json?.response?.docs;
    if (!res?.ok || !Array.isArray(docs)) return comun.CAIDA;

    const resultados = docs.filter((d) => d.halId_s).map(comoResultado);
    return { resultados, total: Number(res.json.response.numFound) || resultados.length, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

async function porIds(ids = []) {
  // Sin la versión: el halId_s del índice no la lleva.
  const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))]
    .filter((i) => ID_VALIDO.test(i))
    .map((i) => i.replace(/v\d+$/i, ''))
    .slice(0, MAX_IDS);
  if (!validos.length) return [];

  // Una sola petición para todos: Solr acepta la lista con OR. Ya validados,
  // no llevan nada que rompa la sintaxis; las comillas son por si acaso.
  const url = urlDe({ q: `halId_s:(${validos.map((i) => `"${i}"`).join(' OR ')})`, rows: validos.length, start: 0 });
  const res = await comun.pedir(url, { base: NOMBRE });
  const docs = res?.json?.response?.docs;
  if (!res?.ok || !Array.isArray(docs)) return [];
  try {
    return docs.filter((d) => d.halId_s).map(comoFicha);
  } catch {
    return [];
  }
}

module.exports = {
  clave: 'hal',
  nombre: 'HAL',
  detalle: 'Archivo abierto de Francia: artículos y tesis, también en español',
  activa: () => true,
  buscar,
  porIds,
};
