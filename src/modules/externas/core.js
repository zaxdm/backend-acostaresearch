'use strict';

/**
 * CORE (core.ac.uk): agrega los repositorios institucionales del mundo, así
 * que trae tesis y artículos con el PDF que depositó la universidad.
 *
 * API v3. La consulta `q` entiende AND/OR y campos (`yearPublished>=2020`,
 * `id:123`). Se usa SOLO con clave (`CORE_API_KEY`, gratuita, se pide en
 * https://core.ac.uk/services/api): sin ella CORE contesta, pero con un cupo
 * anónimo mínimo que un panel con varios tesistas agota enseguida, y entonces
 * la base fallaría a ratos sin explicación. Sin clave se apaga.
 *
 * Contrato en `index.js`.
 */

const comun = require('./comun');

const BASE = 'https://api.core.ac.uk/v3';
const NOMBRE = 'CORE';

/** Los id de CORE son números. */
const FORMA_DEL_ID = /^\d{1,12}$/;

function claveApi() {
  return comun.clave('CORE_API_KEY');
}

function activa() {
  return Boolean(claveApi());
}

function cabeceras() {
  return { Authorization: `Bearer ${claveApi()}` };
}

/** Con la barra final: sin ella CORE responde 301 y se gasta un viaje más. */
function buscarUrl(q, { limite = 25, offset = 0 } = {}) {
  const url = new URL(`${BASE}/search/works/`);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limite));
  url.searchParams.set('offset', String(offset));
  return url;
}

function armarConsulta({ consulta, palabras, desde, hasta }) {
  const base = String(consulta || palabras || '').trim();
  if (!base) return null;
  const partes = [`(${base})`];
  if (desde) partes.push(`yearPublished>=${Number(desde)}`);
  if (hasta) partes.push(`yearPublished<=${Number(hasta)}`);
  return partes.length > 1 ? partes.join(' AND ') : base;
}

/** Un autor que es una institución: no se le buscan apellido ni iniciales. */
const INSTITUCION =
  /[()]|\b(commission|committee|university|universidad|universidade|institute|instituto|ministry|ministerio|association|asociaci[oó]n|society|sociedad|group|grupo|council|consejo|organi[sz]ation|organizaci[oó]n|department|departamento|centre|center|centro)\b/i;

/**
 * CORE da los nombres como los depositó el repositorio: casi siempre
 * «Apellido, Nombre», que se reduce a iniciales; sin coma, una persona pasa
 * por `autoresApa` y una institución se queda como está.
 */
function autoresDe(lista = []) {
  const nombres = (lista ?? [])
    .map((a) => {
      const nombre = String(a?.name ?? '').trim();
      if (!nombre) return null;
      if (INSTITUCION.test(nombre)) return nombre;
      const [apellido, resto] = nombre.split(/,(.*)/s).map((s) => (s ?? '').trim());
      if (!resto) return comun.autoresApa([nombre]);
      const iniciales = resto
        .split(/[\s.]+/)
        .filter((p) => /^\p{L}/u.test(p))
        .map((p) => `${p.charAt(0).toUpperCase()}.`)
        .join(' ');
      return iniciales ? `${apellido}, ${iniciales}` : apellido;
    })
    .filter(Boolean)
    .slice(0, 8);
  // Mismo tope y separador que `comun.autoresApa`.
  return nombres.join('; ') || '(Autor no consignado)';
}

function tipoDe(w) {
  const tipo = String(w.documentType ?? '').toLowerCase();
  if (/thesis|dissertation/.test(tipo)) return 'dissertation';
  if (tipo === 'research' || (w.journals ?? []).length) return 'article';
  return 'other';
}

function comoResultado(w) {
  if (!w?.id || !FORMA_DEL_ID.test(String(w.id))) return null;
  const id = String(w.id);
  const doi = comun.limpiarDoi(w.doi);
  const pagina = (w.links ?? []).find((l) => l?.type === 'display')?.url;
  return {
    id,
    doi,
    titulo: comun.textoLimpio(w.title) ?? '(sin título)',
    autores: autoresDe(w.authors),
    anio: comun.anioDe(w.yearPublished) ?? comun.anioDe(w.publishedDate),
    revista: w.journals?.[0]?.title ?? w.publisher ?? null,
    idioma: w.language?.code ? String(w.language.code).toLowerCase() : null,
    citas: Number(w.citationCount) || 0,
    enlace: pagina ?? `https://core.ac.uk/works/${id}`,
    pdfLibre: w.downloadUrl || null,
    resumen: comun.textoLimpio(w.abstract),
    tipo: tipoDe(w),
  };
}

const TIPOS_DE_FICHA = { article: 'journalArticle', dissertation: 'thesis' };

function comoFicha(w) {
  const r = comoResultado(w);
  if (!r) return null;
  return {
    id: r.id,
    doi: r.doi,
    title: r.titulo,
    authors: r.autores,
    year: r.anio,
    source: r.revista,
    // CORE no guarda volumen, número ni páginas.
    volume: null,
    issue: null,
    pages: null,
    url: r.enlace,
    abstract: r.resumen,
    itemType: TIPOS_DE_FICHA[r.tipo] ?? 'document',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    if (!activa()) return comun.CAIDA;
    const q = armarConsulta({ consulta, palabras, desde, hasta });
    if (!q) return comun.CAIDA;
    const tam = Math.min(Math.max(Number(porPagina) || 25, 1), 100);
    const pag = Math.max(Number(pagina) || 1, 1);

    const res = await comun.pedir(buscarUrl(q, { limite: tam, offset: (pag - 1) * tam }), {
      base: NOMBRE,
      headers: cabeceras(),
    });
    if (!res?.ok) return comun.CAIDA;

    const resultados = (res.json.results ?? []).map(comoResultado).filter(Boolean);
    return { resultados, total: Number(res.json.totalHits) || resultados.length, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

/**
 * Todas las fichas en UNA búsqueda `id:a OR id:b …`: el cupo de CORE cuenta
 * peticiones, y 25 peticiones sueltas lo gastarían de golpe.
 */
async function porIds(ids = []) {
  try {
    if (!activa()) return [];
    const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))]
      .filter((i) => FORMA_DEL_ID.test(i))
      .slice(0, 25);
    if (!validos.length) return [];

    const q = validos.map((i) => `id:${i}`).join(' OR ');
    const res = await comun.pedir(buscarUrl(q, { limite: validos.length }), { base: NOMBRE, headers: cabeceras() });
    if (!res?.ok) return [];
    return (res.json.results ?? [])
      .filter((w) => validos.includes(String(w?.id)))
      .map(comoFicha)
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  clave: 'core',
  nombre: 'CORE',
  detalle: 'Repositorios de universidades: tesis y artículos con PDF',
  activa,
  buscar,
  porIds,
};
