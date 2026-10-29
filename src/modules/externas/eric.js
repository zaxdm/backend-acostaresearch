'use strict';

/**
 * ERIC, la base de educación del Departamento de Educación de EE. UU.
 * Contrato en `index.js`.
 *
 * Ojo: la búsqueda de ERIC une las palabras sueltas con OR (con «artificial
 * intelligence education» devolvía 1,5 millones). Por eso, si no llega la
 * consulta booleana, las palabras se unen con AND aquí.
 *
 * ERIC no tiene campo DOI: cuando lo hay, viene como `url` a doi.org.
 */

const comun = require('./comun');

const BASE = 'https://api.ies.ed.gov/eric/';
const MAXIMO_IDS = 25;
const CAMPOS = [
  'id', 'title', 'author', 'description', 'source', 'sourceid', 'publicationdateyear',
  'publicationtype', 'peerreviewed', 'e_fulltextauth', 'url', 'language', 'publisher',
].join(',');

async function pedir(search, rows, start = 0) {
  const u = new URL(BASE);
  u.searchParams.set('search', search);
  u.searchParams.set('format', 'json');
  u.searchParams.set('rows', String(rows));
  u.searchParams.set('start', String(start));
  u.searchParams.set('fields', CAMPOS);
  const res = await comun.pedir(u, { base: 'ERIC' });
  return res?.ok ? res.json?.response ?? null : null;
}

const IDIOMAS = { English: 'en', Spanish: 'es', Portuguese: 'pt', French: 'fr', German: 'de', Chinese: 'zh' };

function tipo(d) {
  const t = (d.publicationtype ?? []).join('|');
  if (/Dissertations|Theses/i.test(t)) return 'dissertation';
  if (/Journal Articles/i.test(t)) return /Information Analyses/i.test(t) ? 'review' : 'article';
  if (/Books/i.test(t)) return 'book';
  if (/Collected Works/i.test(t)) return 'chapter';
  return 'other';
}

const ITEM = { article: 'journalArticle', review: 'journalArticle', dissertation: 'thesis', book: 'book', chapter: 'bookSection' };

/** «v21 n3 p1-9 2024» → volumen, número y páginas. */
function partesDeLaFuente(sourceid) {
  const s = String(sourceid ?? '');
  return {
    volume: s.match(/\bv(\w+)/)?.[1] ?? null,
    issue: s.match(/\bn(\w+)/)?.[1] ?? null,
    pages: s.match(/\bp([\w-]+)/)?.[1] ?? null,
  };
}

function aResultado(d) {
  const doi = /doi\.org\//i.test(d.url ?? '') ? comun.limpiarDoi(d.url) : null;
  return {
    id: d.id,
    doi,
    titulo: comun.textoLimpio(d.title) ?? '(sin título)',
    autores: comun.autoresApa(d.author ?? []),
    anio: comun.anioDe(d.publicationdateyear),
    revista: d.source ?? null,
    idioma: IDIOMAS[d.language?.[0]] ?? d.language?.[0] ?? null,
    // ERIC no cuenta citas.
    citas: 0,
    enlace: d.url || `https://eric.ed.gov/?id=${d.id}`,
    // Solo cuando ERIC tiene permiso del autor para alojar el texto completo.
    pdfLibre: Number(d.e_fulltextauth) === 1 ? `https://files.eric.ed.gov/fulltext/${d.id}.pdf` : null,
    resumen: comun.textoLimpio(d.description),
    tipo: tipo(d),
    revisadoPorPares: d.peerreviewed === 'T',
  };
}

function aFicha(d) {
  const r = aResultado(d);
  return {
    id: r.id,
    doi: r.doi,
    title: r.titulo,
    authors: r.autores,
    year: r.anio,
    source: r.revista,
    ...partesDeLaFuente(d.sourceid),
    url: r.enlace,
    abstract: r.resumen,
    itemType: ITEM[r.tipo] ?? 'document',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    const termino = String(consulta || '').trim() || String(palabras || '').trim().split(/\s+/).filter(Boolean).join(' AND ');
    if (!termino) return { resultados: [], total: 0, caida: false };
    const tam = Math.min(Math.max(Number(porPagina) || 25, 1), MAXIMO_IDS);
    const pag = Math.max(Number(pagina) || 1, 1);

    let search = `(${termino})`;
    if (desde || hasta) search += ` AND publicationdateyear:[${desde || 1900} TO ${hasta || 3000}]`;

    const r = await pedir(search, tam, (pag - 1) * tam);
    if (!r) return comun.CAIDA;
    const resultados = (r.docs ?? []).filter((d) => d.id).map(aResultado);
    return { resultados, total: Number(r.numFound) || 0, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i).trim().toUpperCase()))]
    .filter((i) => /^E[DJ]\d{1,9}$/.test(i))
    .slice(0, MAXIMO_IDS);
  if (validos.length === 0) return [];
  const r = await pedir(validos.map((i) => `id:${i}`).join(' OR '), validos.length);
  const pedidos = new Set(validos);
  return (r?.docs ?? []).filter((d) => pedidos.has(d.id)).map(aFicha);
}

module.exports = {
  clave: 'eric',
  nombre: 'ERIC',
  detalle: 'Educación',
  activa: () => true,
  buscar,
  porIds,
};
