'use strict';

/**
 * OpenAIRE: el grafo europeo que junta Crossref, repositorios universitarios
 * (tesis incluidas) y archivos abiertos, ya sin duplicados. Sin clave.
 *
 * Se usa la Graph API v1 (https://api.openaire.eu/graph/v1/researchProducts) y
 * no la antigua /search/publications: la nueva contesta JSON limpio en ~1 s,
 * entiende AND/OR y comillas en `search`, filtra por fechas y deja pedir varias
 * fichas a la vez repitiendo `id`. Sin clave el cupo es amplio (cabecera
 * x-ratelimit-limit: 7199 por hora, comprobado el 28-oct-2026).
 * Contrato: ver `index.js`.
 */

const comun = require('./comun');

const BASE = 'https://api.openaire.eu/graph/v1/researchProducts';
const NOMBRE = 'OpenAIRE';
const MAX_IDS = 25;

/**
 * «doi_dedup___::c7f117c43a0c7051aef9069f115f00cd»: prefijo de 12 caracteres
 * (letras, cifras y guiones bajos), «::» y un hash MD5. Nada más pasa.
 */
const ID_VALIDO = /^[A-Za-z0-9_]{12}::[a-f0-9]{32}$/;

/** OpenAIRE da los idiomas en ISO 639-3; la web usa los de dos letras. */
const IDIOMAS = { eng: 'en', spa: 'es', por: 'pt', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', cat: 'ca', zho: 'zh', chi: 'zh' };

const ITEM_TYPES = {
  article: 'journalArticle',
  review: 'journalArticle',
  dissertation: 'thesis',
  book: 'book',
  chapter: 'bookSection',
  preprint: 'preprint',
};

/**
 * El tipo sale de las copias («instances») del trabajo. Si alguna es una
 * tesis, es tesis: el repositorio de la universidad sabe más que Crossref.
 */
function tipoDe(producto) {
  const tipos = (producto.instances ?? []).map((i) => String(i.type ?? '').toLowerCase());
  if (tipos.some((t) => t.includes('thesis'))) return 'dissertation';
  const t = tipos[0] ?? '';
  if (t.includes('review')) return 'review';
  if (t.includes('preprint')) return 'preprint';
  if (t.includes('part of book') || t.includes('chapter')) return 'chapter';
  if (t === 'book') return 'book';
  if (t === 'article' || t === 'data paper') return 'article';
  return 'other';
}

/** «Qu, J.» desde apellido y nombre separados; si no vienen, el nombre completo. */
function autores(producto) {
  const lista = [...(producto.authors ?? [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return comun.autoresApa(
    lista.map((a) => {
      if (a.surname && a.name) {
        const iniciales = String(a.name)
          .split(/\s+/)
          .filter(Boolean)
          .map((n) => `${n.charAt(0).toUpperCase()}.`)
          .join(' ');
        return `${a.surname}, ${iniciales}`;
      }
      return a.fullName;
    }),
  );
}

function doiDe(producto) {
  const pid = (producto.pids ?? []).find((p) => p.scheme === 'doi');
  return comun.limpiarDoi(pid?.value);
}

/** El primer enlace que acaba en .pdf, de las copias en acceso abierto. */
function pdfDe(producto) {
  const abierto = producto.bestAccessRight?.label === 'OPEN';
  for (const inst of producto.instances ?? []) {
    const instAbierta = inst.accessRight?.label ? inst.accessRight.label === 'OPEN' : abierto;
    if (!instAbierta) continue;
    const url = (inst.urls ?? []).find((u) => /\.pdf(\?|$)/i.test(String(u)));
    if (url) return url;
  }
  return null;
}

function enlaceDe(producto) {
  const doi = doiDe(producto);
  if (doi) return `https://doi.org/${doi}`;
  const url = (producto.instances ?? []).flatMap((i) => i.urls ?? [])[0];
  return url ?? `https://explore.openaire.eu/search/result?id=${encodeURIComponent(producto.id)}`;
}

function paginas(c) {
  if (!c?.sp) return null;
  return c.ep ? `${c.sp}-${c.ep}` : c.sp;
}

function comoResultado(p) {
  return {
    id: p.id,
    doi: doiDe(p),
    titulo: comun.textoLimpio(p.mainTitle) ?? '(sin título)',
    autores: autores(p),
    anio: comun.anioDe(p.publicationDate),
    revista: p.container?.name ?? p.publisher ?? null,
    idioma: IDIOMAS[p.language?.code] ?? null,
    citas: Math.round(Number(p.indicators?.citationImpact?.citationCount) || 0),
    enlace: enlaceDe(p),
    pdfLibre: pdfDe(p),
    // Llega con etiquetas JATS («<jats:p>»); textoLimpio las quita.
    resumen: comun.textoLimpio((p.descriptions ?? [])[0]),
    tipo: tipoDe(p),
  };
}

function comoFicha(p) {
  return {
    id: p.id,
    doi: doiDe(p),
    title: comun.textoLimpio(p.mainTitle) ?? '(sin título)',
    authors: autores(p),
    year: comun.anioDe(p.publicationDate),
    source: p.container?.name ?? p.publisher ?? null,
    volume: p.container?.vol ?? null,
    issue: p.container?.iss ?? null,
    pages: paginas(p.container),
    url: enlaceDe(p),
    abstract: comun.textoLimpio((p.descriptions ?? [])[0]),
    itemType: ITEM_TYPES[tipoDe(p)] ?? 'document',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    const texto = String(consulta || palabras || '').trim();
    if (!texto) return { resultados: [], total: 0, caida: false };

    const url = new URL(BASE);
    url.searchParams.set('search', texto);
    url.searchParams.set('type', 'publication');
    url.searchParams.set('page', String(Math.max(Number(pagina) || 1, 1)));
    url.searchParams.set('pageSize', String(Math.min(Math.max(Number(porPagina) || 25, 1), 25)));
    if (desde) url.searchParams.set('fromPublicationDate', `${desde}-01-01`);
    if (hasta) url.searchParams.set('toPublicationDate', `${hasta}-12-31`);

    const res = await comun.pedir(url, { base: NOMBRE });
    if (!res?.ok || !Array.isArray(res.json?.results)) return comun.CAIDA;

    const resultados = res.json.results.filter((p) => p.id).map(comoResultado);
    return { resultados, total: Number(res.json.header?.numFound) || resultados.length, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))]
    .filter((i) => ID_VALIDO.test(i))
    .slice(0, MAX_IDS);
  if (!validos.length) return [];

  // Todos en una petición: la API acepta `id` repetido. searchParams codifica los «::».
  const url = new URL(BASE);
  for (const id of validos) url.searchParams.append('id', id);
  url.searchParams.set('pageSize', String(validos.length));

  const res = await comun.pedir(url, { base: NOMBRE });
  if (!res?.ok || !Array.isArray(res.json?.results)) return [];
  try {
    return res.json.results.filter((p) => validos.includes(p.id)).map(comoFicha);
  } catch {
    return [];
  }
}

module.exports = {
  clave: 'openaire',
  nombre: 'OpenAIRE',
  detalle: 'Repositorios universitarios de Europa, con tesis',
  activa: () => true,
  buscar,
  porIds,
};
