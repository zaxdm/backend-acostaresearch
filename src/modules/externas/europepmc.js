'use strict';

/**
 * Europe PMC: PubMed más PMC, preprints (PPR), tesis británicas (ETH) y otras
 * fuentes, con citas y enlace a PDF abierto. Contrato en `index.js`.
 *
 * El id de un registro solo es único dentro de su fuente («MED» 123 y «PMC» 123
 * no son lo mismo), así que el id que sale de aquí es «FUENTE-id»: «MED-41797731».
 *
 * PAGINACIÓN: la API ya no hace caso de `page` (lo comprobamos el 28-oct-2026:
 * la página 2 devolvía la 1). Solo pagina con `cursorMark`, y el cursor de la
 * página N solo se conoce pidiendo las anteriores. Para no traer N páginas
 * completas, se salta lo anterior con una petición `idlist` (solo ids, hasta
 * 1000 por vez) y se guarda el cursor por si el tesista sigue a la siguiente.
 */

const comun = require('./comun');
const { autorDePubmed } = require('./pubmed');

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const MAXIMO_IDS = 25;
/** Más allá de esto no se salta: serían más de 10 peticiones por una página. */
const MAXIMO_SALTO = 10_000;

const FUENTES = new Set(['MED', 'PMC', 'PPR', 'AGR', 'CBA', 'CTX', 'ETH', 'HIR', 'PAT', 'CIT']);

/** Cursores ya conocidos: «consulta|porPagina|pagina» → cursorMark. */
const cursores = new Map();
const MAXIMO_CURSORES = 500;

function guardarCursor(llave, cursor) {
  if (!cursor) return;
  if (cursores.size >= MAXIMO_CURSORES) cursores.delete(cursores.keys().next().value);
  cursores.set(llave, cursor);
}

function url(params) {
  const u = new URL(BASE);
  u.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u;
}

async function pedir(params) {
  const res = await comun.pedir(url(params), { base: 'Europe PMC' });
  return res?.ok ? res.json : null;
}

/** El cursor con el que empieza la página pedida, o null si no se pudo llegar. */
async function cursorDe(query, tam, pagina) {
  if (pagina <= 1) return '*';
  const llave = `${query}|${tam}|${pagina}`;
  if (cursores.has(llave)) return cursores.get(llave);

  let faltan = (pagina - 1) * tam;
  if (faltan > MAXIMO_SALTO) return null;
  let cursor = '*';
  while (faltan > 0) {
    const trozo = Math.min(faltan, 1000);
    const datos = await pedir({ query, resultType: 'idlist', pageSize: trozo, cursorMark: cursor });
    if (!datos?.nextCursorMark) return null;
    cursor = datos.nextCursorMark;
    faltan -= trozo;
  }
  guardarCursor(llave, cursor);
  return cursor;
}

function iniciales(texto) {
  return Array.from(String(texto ?? '').replace(/[^\p{L}]/gu, ''), (c) => `${c}.`).join(' ');
}

function autores(r) {
  const lista = r.authorList?.author ?? [];
  const nombres = lista
    .map((a) => {
      if (a.collectiveName) return a.collectiveName;
      if (a.lastName && a.initials) return `${a.lastName}, ${iniciales(a.initials)}`;
      return autorDePubmed(a.fullName);
    })
    .filter(Boolean)
    .slice(0, 8);
  if (nombres.length) return nombres.join('; ');
  // Sin lista, la cadena «Smith J, Pérez A.» trae lo mismo.
  const deCadena = String(r.authorString ?? '')
    .split(',')
    .map(autorDePubmed)
    .filter(Boolean)
    .slice(0, 8);
  return deCadena.join('; ') || '(Autor no consignado)';
}

const IDIOMAS = { eng: 'en', spa: 'es', por: 'pt', fre: 'fr', ger: 'de', ita: 'it', chi: 'zh', jpn: 'ja', rus: 'ru' };

function tipo(r) {
  if (r.source === 'ETH') return 'dissertation';
  if (r.source === 'PAT') return 'other';
  const t = (r.pubTypeList?.pubType ?? []).join('|');
  if (/preprint/i.test(t) || r.source === 'PPR') return 'preprint';
  if (/review/i.test(t)) return 'review';
  if (/thesis|dissertation/i.test(t)) return 'dissertation';
  if (/chapter/i.test(t)) return 'chapter';
  if (/book/i.test(t)) return 'book';
  if (/^(letter|editorial|comment|news)(\||$)/i.test(t) && !/journal article|research-article/i.test(t)) return 'other';
  return 'article';
}

const ITEM = { dissertation: 'thesis', preprint: 'preprint', book: 'book', chapter: 'bookSection', other: 'document' };

/** El PDF abierto, si Europe PMC dice que lo es (`availabilityCode` 'OA'). */
function pdfLibre(r) {
  const enlaces = r.fullTextUrlList?.fullTextUrl ?? [];
  return enlaces.find((f) => f.availabilityCode === 'OA' && f.documentStyle === 'pdf')?.url ?? null;
}

function aResultado(r) {
  return {
    id: `${r.source}-${r.id}`,
    doi: comun.limpiarDoi(r.doi),
    titulo: comun.textoLimpio(r.title) ?? '(sin título)',
    autores: autores(r),
    anio: comun.anioDe(r.pubYear) ?? comun.anioDe(r.firstPublicationDate),
    revista: r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher ?? null,
    idioma: r.language ? (IDIOMAS[r.language] ?? r.language) : null,
    citas: Number(r.citedByCount) || 0,
    enlace: `https://europepmc.org/article/${r.source}/${r.id}`,
    pdfLibre: pdfLibre(r),
    resumen: comun.textoLimpio(r.abstractText),
    tipo: tipo(r),
  };
}

function aFicha(r) {
  const x = aResultado(r);
  return {
    id: x.id,
    doi: x.doi,
    title: x.titulo,
    authors: x.autores,
    year: x.anio,
    source: x.revista,
    volume: r.journalInfo?.volume ?? null,
    issue: r.journalInfo?.issue ?? null,
    pages: r.pageInfo ?? null,
    url: x.enlace,
    abstract: x.resumen,
    itemType: ITEM[x.tipo] ?? 'journalArticle',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    const termino = String(consulta || palabras || '').trim();
    if (!termino) return { resultados: [], total: 0, caida: false };
    const tam = Math.min(Math.max(Number(porPagina) || 25, 1), MAXIMO_IDS);
    const pag = Math.max(Number(pagina) || 1, 1);

    let query = `(${termino})`;
    if (desde || hasta) query += ` AND PUB_YEAR:[${desde || 1800} TO ${hasta || 3000}]`;

    const cursor = await cursorDe(query, tam, pag);
    if (!cursor) return comun.CAIDA;
    const datos = await pedir({ query, resultType: 'core', pageSize: tam, cursorMark: cursor });
    if (!datos) return comun.CAIDA;

    guardarCursor(`${query}|${tam}|${pag + 1}`, datos.nextCursorMark);
    const resultados = (datos.resultList?.result ?? []).filter((r) => r.id && r.source).map(aResultado);
    return { resultados, total: Number(datos.hitCount) || 0, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

/** «MED-123» (o «MED:123») → { fuente, id }, o null si no tiene esa forma. */
function partirId(crudo) {
  const m = String(crudo ?? '').trim().match(/^([A-Z]{3})[-:]([A-Za-z0-9]{1,20})$/);
  return m && FUENTES.has(m[1]) ? { fuente: m[1], id: m[2] } : null;
}

async function porIds(ids = []) {
  const vistos = new Set();
  const pares = [];
  for (const crudo of ids ?? []) {
    const par = partirId(crudo);
    if (!par || vistos.has(`${par.fuente}-${par.id}`)) continue;
    vistos.add(`${par.fuente}-${par.id}`);
    pares.push(par);
    if (pares.length === MAXIMO_IDS) break;
  }
  if (pares.length === 0) return [];

  const query = pares.map((p) => `(EXT_ID:${p.id} AND SRC:${p.fuente})`).join(' OR ');
  const datos = await pedir({ query, resultType: 'core', pageSize: MAXIMO_IDS });
  return (datos?.resultList?.result ?? [])
    .filter((r) => vistos.has(`${r.source}-${r.id}`))
    .map(aFicha);
}

module.exports = {
  clave: 'europepmc',
  nombre: 'Europe PMC',
  detalle: 'Biomedicina y ciencias de la vida, con preprints',
  activa: () => true,
  buscar,
  porIds,
};
