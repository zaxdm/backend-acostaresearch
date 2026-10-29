'use strict';

/**
 * DOAJ (Directory of Open Access Journals): solo revistas de acceso abierto
 * revisadas por pares, así que todo lo que sale se puede leer entero.
 *
 * API v4 (la vigente en octubre de 2026; la v3 sigue contestando igual). La
 * consulta va EN LA RUTA y entiende la sintaxis de Elasticsearch, con AND/OR
 * y campos (`bibjson.year:[a TO b]`, `id:(x OR y)`). Sin clave para leer.
 *
 * Contrato en `index.js`.
 */

const comun = require('./comun');

const BASE = 'https://doaj.org/api/v4';
const NOMBRE = 'DOAJ';

/** DOAJ no deja pasar del registro 1000 de una búsqueda (responde 400). */
const TOPE_DE_REGISTROS = 1000;

/** Los id de DOAJ son 32 caracteres hexadecimales. */
const FORMA_DEL_ID = /^[0-9a-f]{32}$/i;

function buscarUrl(consulta, { pagina = 1, porPagina = 25 } = {}) {
  // `encodeURIComponent` también codifica la «/» de los DOI, que en la ruta
  // partiría la consulta en dos.
  const url = new URL(`${BASE}/search/articles/${encodeURIComponent(consulta)}`);
  url.searchParams.set('page', String(pagina));
  url.searchParams.set('pageSize', String(porPagina));
  return url;
}

/** La consulta booleana con el rango de años, si lo hay. */
function armarConsulta({ consulta, palabras, desde, hasta }) {
  const base = String(consulta || palabras || '').trim();
  if (!base) return null;
  if (!desde && !hasta) return base;
  // Un extremo abierto en Elasticsearch es «*».
  return `(${base}) AND bibjson.year:[${desde || '*'} TO ${hasta || '*'}]`;
}

function doiDe(bib) {
  const id = (bib.identifier ?? []).find((i) => String(i.type).toLowerCase() === 'doi');
  return comun.limpiarDoi(id?.id);
}

/** El enlace al texto y, si DOAJ lo marca como PDF, el PDF. */
function enlaces(bib, doi) {
  const lista = (bib.link ?? []).filter((l) => l?.url);
  const pdf = lista.find((l) => /pdf/i.test(l.content_type ?? ''));
  const texto = lista.find((l) => l.type === 'fulltext') ?? lista[0];
  return {
    enlace: texto?.url ?? (doi ? `https://doi.org/${doi}` : null),
    pdfLibre: pdf?.url ?? null,
  };
}

function idiomaDe(bib) {
  const idioma = bib.journal?.language?.[0];
  return idioma ? String(idioma).toLowerCase() : null;
}

function autoresDe(bib) {
  return comun.autoresApa((bib.author ?? []).map((a) => a?.name));
}

function comoResultado(registro) {
  const bib = registro?.bibjson;
  if (!registro?.id || !bib) return null;
  const doi = doiDe(bib);
  return {
    id: registro.id,
    doi,
    titulo: comun.textoLimpio(bib.title) ?? '(sin título)',
    autores: autoresDe(bib),
    anio: comun.anioDe(bib.year),
    revista: bib.journal?.title ?? null,
    idioma: idiomaDe(bib),
    // DOAJ no cuenta citas.
    citas: 0,
    ...enlaces(bib, doi),
    resumen: comun.textoLimpio(bib.abstract),
    // DOAJ solo indexa artículos de revista; no distingue las revisiones.
    tipo: 'article',
  };
}

function comoFicha(registro) {
  const r = comoResultado(registro);
  if (!r) return null;
  const bib = registro.bibjson;
  const inicio = bib.start_page ? String(bib.start_page).trim() : '';
  const fin = bib.end_page ? String(bib.end_page).trim() : '';
  return {
    id: r.id,
    doi: r.doi,
    title: r.titulo,
    authors: r.autores,
    year: r.anio,
    source: r.revista,
    volume: bib.journal?.volume ? String(bib.journal.volume) : null,
    issue: bib.journal?.number ? String(bib.journal.number) : null,
    pages: inicio ? (fin && fin !== inicio ? `${inicio}-${fin}` : inicio) : null,
    url: r.enlace,
    abstract: r.resumen,
    itemType: 'journalArticle',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    const q = armarConsulta({ consulta, palabras, desde, hasta });
    if (!q) return comun.CAIDA;
    const tam = Math.min(Math.max(Number(porPagina) || 25, 1), 100);
    const pag = Math.max(Number(pagina) || 1, 1);
    // Más allá del registro 1000 DOAJ da 400: se contesta vacío sin pedir.
    if ((pag - 1) * tam >= TOPE_DE_REGISTROS) return { resultados: [], total: TOPE_DE_REGISTROS, caida: false };

    const res = await comun.pedir(buscarUrl(q, { pagina: pag, porPagina: tam }), { base: NOMBRE });
    if (!res?.ok) return comun.CAIDA;

    const resultados = (res.json.results ?? []).map(comoResultado).filter(Boolean);
    // Se anuncia como mucho el tope, para que la web no ofrezca páginas que DOAJ no da.
    const total = Math.min(Number(res.json.total) || resultados.length, TOPE_DE_REGISTROS);
    return { resultados, total, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

/** Todas las fichas en UNA búsqueda `id:(a OR b …)`, en vez de una petición por id. */
async function porIds(ids = []) {
  try {
    const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim().toLowerCase()))]
      .filter((i) => FORMA_DEL_ID.test(i))
      .slice(0, 25);
    if (!validos.length) return [];

    const res = await comun.pedir(buscarUrl(`id:(${validos.join(' OR ')})`, { porPagina: validos.length }), {
      base: NOMBRE,
    });
    if (!res?.ok) return [];
    return (res.json.results ?? [])
      .filter((r) => validos.includes(String(r?.id).toLowerCase()))
      .map(comoFicha)
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  clave: 'doaj',
  nombre: 'DOAJ',
  detalle: 'Revistas de acceso abierto revisadas por pares',
  activa: () => true,
  buscar,
  porIds,
};
