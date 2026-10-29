'use strict';

/**
 * Zenodo (CERN): repositorio abierto donde autores y revistas pequeñas dejan
 * artículos, preprints, tesis y capítulos, casi siempre con el PDF. Sin clave.
 *
 * API: https://zenodo.org/api/records — `q` en sintaxis Elasticsearch (entiende
 * AND/OR, comillas y rangos), `size`, `page` y `type=publication`, que deja fuera
 * datasets, software, imágenes y pósteres (comprobado el 28-oct-2026: el filtro
 * vigente es el parámetro `type`, igual que `resource_type.type:publication` en `q`).
 * Contrato: ver `index.js`.
 */

const comun = require('./comun');

const BASE = 'https://zenodo.org/api/records';
const NOMBRE = 'Zenodo';
const MAX_IDS = 25;

/** El id de Zenodo es el número del registro («8280959»). */
const ID_VALIDO = /^\d{1,12}$/;

/** Zenodo da los idiomas en ISO 639-3; la web usa los de dos letras. */
const IDIOMAS = { eng: 'en', spa: 'es', por: 'pt', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', cat: 'ca', zho: 'zh', chi: 'zh' };

/** subtype de Zenodo → tipo del contrato. «dissertation» es la tesis. */
const TIPOS = {
  article: 'article',
  preprint: 'preprint',
  dissertation: 'dissertation',
  thesis: 'dissertation',
  book: 'book',
  section: 'chapter',
};

const ITEM_TYPES = {
  article: 'journalArticle',
  review: 'journalArticle',
  dissertation: 'thesis',
  book: 'book',
  chapter: 'bookSection',
  preprint: 'preprint',
};

/**
 * Zenodo guarda a los autores como «Apellido, Nombre». `autoresApa` deja
 * intacto lo que ya trae coma, así que las iniciales se ponen aquí.
 */
function autorApa(nombre) {
  const texto = String(nombre ?? '').trim();
  const coma = texto.indexOf(',');
  if (coma < 0) return texto;
  const apellido = texto.slice(0, coma).trim();
  const iniciales = texto
    .slice(coma + 1)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => `${n.charAt(0).toUpperCase()}.`)
    .join(' ');
  return iniciales ? `${apellido}, ${iniciales}` : apellido;
}

/** Rango de fechas de Elasticsearch; el lado que falte queda abierto («*»). */
function rangoDeAnios(desde, hasta) {
  if (!desde && !hasta) return null;
  const de = desde ? `${desde}-01-01` : '*';
  const a = hasta ? `${hasta}-12-31` : '*';
  return `publication_date:[${de} TO ${a}]`;
}

/** El primer PDF del registro, solo si el acceso es abierto (si no, el enlace da 403). */
function pdfDe(registro) {
  if (registro.metadata?.access_right !== 'open') return null;
  const archivo = (registro.files ?? []).find((f) => /\.pdf$/i.test(String(f.key ?? '')));
  return archivo?.links?.self ?? null;
}

function tipoDe(metadata) {
  return TIPOS[metadata?.resource_type?.subtype] ?? 'other';
}

function fuenteDe(m) {
  return m.journal?.title ?? m.imprint?.title ?? m.meeting?.title ?? m.thesis?.university ?? m.imprint?.publisher ?? null;
}

function comoResultado(r) {
  const m = r.metadata ?? {};
  return {
    id: String(r.id),
    doi: comun.limpiarDoi(r.doi ?? m.doi),
    titulo: comun.textoLimpio(m.title) ?? '(sin título)',
    autores: comun.autoresApa((m.creators ?? []).map((c) => autorApa(c.name))),
    anio: comun.anioDe(m.publication_date),
    revista: fuenteDe(m),
    idioma: IDIOMAS[m.language] ?? m.language ?? null,
    // Zenodo no cuenta citas.
    citas: 0,
    enlace: r.links?.self_html ?? `https://zenodo.org/records/${r.id}`,
    pdfLibre: pdfDe(r),
    resumen: comun.textoLimpio(m.description),
    tipo: tipoDe(m),
  };
}

function comoFicha(r) {
  const m = r.metadata ?? {};
  return {
    id: String(r.id),
    doi: comun.limpiarDoi(r.doi ?? m.doi),
    title: comun.textoLimpio(m.title) ?? '(sin título)',
    authors: comun.autoresApa((m.creators ?? []).map((c) => autorApa(c.name))),
    year: comun.anioDe(m.publication_date),
    source: fuenteDe(m),
    volume: m.journal?.volume ?? null,
    issue: m.journal?.issue ?? null,
    pages: m.journal?.pages ?? m.imprint?.pages ?? null,
    url: r.links?.self_html ?? `https://zenodo.org/records/${r.id}`,
    abstract: comun.textoLimpio(m.description),
    itemType: ITEM_TYPES[tipoDe(m)] ?? 'document',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    // Zenodo une las palabras sueltas con OR (424 mil resultados frente a 16 mil
    // para «artificial intelligence education»): sin consulta, se exigen todas.
    // Fuera los signos de la sintaxis de Elasticsearch, que romperían la consulta.
    const sueltas = String(palabras ?? '').replace(/[\\():"[\]{}^~*?!/+-]/g, ' ').trim().split(/\s+/).filter(Boolean).join(' AND ');
    const texto = String(consulta || sueltas || '').trim();
    // Sin nada que buscar no hay fallo: solo no hay resultados.
    if (!texto) return { resultados: [], total: 0, caida: false };
    const rango = rangoDeAnios(desde, hasta);

    const url = new URL(BASE);
    url.searchParams.set('q', rango ? `(${texto}) AND ${rango}` : texto);
    url.searchParams.set('type', 'publication');
    url.searchParams.set('size', String(Math.min(Math.max(Number(porPagina) || 25, 1), 25)));
    url.searchParams.set('page', String(Math.max(Number(pagina) || 1, 1)));
    url.searchParams.set('sort', 'bestmatch');

    const res = await comun.pedir(url, { base: NOMBRE });
    if (!res?.ok || !Array.isArray(res.json?.hits?.hits)) return comun.CAIDA;

    const resultados = res.json.hits.hits.map(comoResultado);
    // `total` llega como número (o como { value } en versiones viejas del índice).
    const total = Number(res.json.hits.total?.value ?? res.json.hits.total) || resultados.length;
    return { resultados, total, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))]
    .filter((i) => ID_VALIDO.test(i))
    .slice(0, MAX_IDS);

  // Uno por uno: la API de registros no admite pedir varios por id a la vez.
  const fichas = await Promise.all(
    validos.map(async (id) => {
      const res = await comun.pedir(`${BASE}/${id}`, { base: NOMBRE });
      if (!res?.ok || !res.json?.id) return null;
      try {
        return comoFicha(res.json);
      } catch {
        return null;
      }
    }),
  );
  return fichas.filter(Boolean);
}

module.exports = {
  clave: 'zenodo',
  nombre: 'Zenodo',
  detalle: 'Repositorio abierto del CERN: artículos, preprints y tesis con PDF',
  activa: () => true,
  buscar,
  porIds,
};
