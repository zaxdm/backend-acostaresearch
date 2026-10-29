'use strict';

/**
 * Crossref como base del buscador: todo lo que tiene DOI, de cualquier
 * editorial, incluidas las revistas latinoamericanas que depositan allí.
 *
 * Lo que hay que saber: NO entiende AND/OR (`query.bibliographic` puntúa por
 * palabras), por eso se le manda `palabras`; casi no trae resúmenes, y cuando
 * los trae vienen en JATS; no dice si hay PDF libre. Sin clave: basta el
 * `mailto` para entrar en el grupo de tráfico «educado».
 *
 * `references/crossref.client.js` es otra cosa (completar fichas por DOI) y no
 * se toca. Aquí el id ES el DOI. Contrato en `index.js`.
 */

const comun = require('./comun');

const BASE = 'https://api.crossref.org/works';
const NOMBRE = 'Crossref';

/** Crossref no admite `offset` por encima de 10 000 (para más pide cursores). */
const TOPE_DE_REGISTROS = 10_000;

/** Sin `select` cada obra trae sus referencias enteras: decenas de KB por resultado. */
const CAMPOS = [
  'DOI',
  'URL',
  'type',
  'title',
  'author',
  'issued',
  'published-print',
  'published-online',
  'container-title',
  'volume',
  'issue',
  'page',
  'is-referenced-by-count',
  'abstract',
].join(',');

/** La forma de un DOI. Sin espacios; la coma se trata aparte en `porIds`. */
const FORMA_DEL_DOI = /^10\.\d{4,9}\/\S+$/;

const TIPOS = {
  'journal-article': 'article',
  dissertation: 'dissertation',
  'posted-content': 'preprint',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-chapter': 'chapter',
  'book-section': 'chapter',
  'book-part': 'chapter',
  'reference-entry': 'chapter',
};

const TIPOS_DE_FICHA = {
  article: 'journalArticle',
  dissertation: 'thesis',
  preprint: 'preprint',
  book: 'book',
  chapter: 'bookSection',
};

function firmar(url) {
  url.searchParams.set('mailto', comun.contacto());
  return url;
}

function primero(valor) {
  return Array.isArray(valor) ? valor[0] ?? null : valor ?? null;
}

/**
 * «Smith», «John Albert» → «Smith, J. A.». Las instituciones (`name` sin
 * `family`) van tal cual: Crossref ya dice que no son personas, y pasarlas por
 * `autoresApa` las partiría como si lo fueran («Consorcio X» → «X, C.»).
 */
function autoresDe(lista = []) {
  const nombres = (lista ?? [])
    .map((p) => {
      const apellido = String(p?.family ?? '').trim();
      const nombre = String(p?.given ?? '').trim();
      if (!apellido) return String(p?.name ?? '').trim();
      const iniciales = nombre
        .split(/[\s.]+/)
        .filter(Boolean)
        .map((parte) => `${parte.charAt(0).toUpperCase()}.`)
        .join(' ');
      // Con la coma puesta `autoresApa` no vuelve a adivinar el apellido.
      return iniciales ? `${apellido}, ${iniciales}` : apellido;
    })
    .filter(Boolean)
    .slice(0, 8);
  // Mismo tope y separador que `comun.autoresApa`.
  return nombres.join('; ') || '(Autor no consignado)';
}

function anioDe(m) {
  const partes =
    m.issued?.['date-parts']?.[0] ??
    m['published-print']?.['date-parts']?.[0] ??
    m['published-online']?.['date-parts']?.[0] ??
    [];
  return comun.anioDe(partes[0]);
}

function comoResultado(m) {
  const doi = comun.limpiarDoi(m?.DOI);
  if (!doi) return null;
  return {
    id: doi,
    doi,
    // Los títulos traen a veces cursivas en JATS: «<i>Lima</i>».
    titulo: comun.textoLimpio(primero(m.title)) ?? '(sin título)',
    autores: autoresDe(m.author),
    anio: anioDe(m),
    revista: comun.textoLimpio(primero(m['container-title'])),
    // `language` no se puede pedir en `select` (Crossref responde 400).
    idioma: null,
    citas: Number(m['is-referenced-by-count']) || 0,
    enlace: m.URL ?? `https://doi.org/${doi}`,
    // Los `link` de Crossref son para minería de textos y suelen estar tras pago.
    pdfLibre: null,
    resumen: comun.textoLimpio(m.abstract),
    tipo: TIPOS[m.type] ?? 'other',
  };
}

function comoFicha(m) {
  const r = comoResultado(m);
  if (!r) return null;
  return {
    id: r.id,
    doi: r.doi,
    title: r.titulo,
    authors: r.autores,
    year: r.anio,
    source: r.revista,
    volume: m.volume ? String(m.volume) : null,
    issue: m.issue ? String(m.issue) : null,
    pages: m.page ? String(m.page).replace(/\s*[-–—]+\s*/, '-') : null,
    url: r.enlace,
    abstract: r.resumen,
    itemType: TIPOS_DE_FICHA[r.tipo] ?? 'document',
  };
}

async function buscar({ palabras, consulta, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  try {
    // Sin `palabras` se usa la booleana despojada de operadores y comillas.
    const texto = String(palabras || String(consulta ?? '').replace(/\b(AND|OR|NOT)\b|[()"]/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!texto) return comun.CAIDA;

    const tam = Math.min(Math.max(Number(porPagina) || 25, 1), 100);
    const pag = Math.max(Number(pagina) || 1, 1);
    const offset = (pag - 1) * tam;
    if (offset >= TOPE_DE_REGISTROS) return { resultados: [], total: TOPE_DE_REGISTROS, caida: false };

    const url = new URL(BASE);
    url.searchParams.set('query.bibliographic', texto);
    url.searchParams.set('rows', String(tam));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('select', CAMPOS);
    const filtros = [];
    if (desde) filtros.push(`from-pub-date:${desde}`);
    if (hasta) filtros.push(`until-pub-date:${hasta}`);
    if (filtros.length) url.searchParams.set('filter', filtros.join(','));
    firmar(url);

    const res = await comun.pedir(url, { base: NOMBRE });
    if (!res?.ok || !res.json?.message) return comun.CAIDA;

    const resultados = (res.json.message.items ?? []).map(comoResultado).filter(Boolean);
    const total = Math.min(Number(res.json.message['total-results']) || resultados.length, TOPE_DE_REGISTROS);
    return { resultados, total, caida: false };
  } catch {
    return comun.CAIDA;
  }
}

/** Una obra por su DOI, por la ruta `/works/<doi>`. */
async function unaPorDoi(doi) {
  const res = await comun.pedir(firmar(new URL(`${BASE}/${encodeURIComponent(doi)}`)), { base: NOMBRE });
  return res?.ok ? res.json?.message ?? null : null;
}

/**
 * Las fichas por DOI. Las que se pueden van en UNA petición `filter=doi:a,doi:b`;
 * un DOI con coma rompería ese filtro, y esos (rarísimos) se piden uno a uno.
 */
async function porIds(ids = []) {
  try {
    const validos = [...new Set((ids ?? []).map((i) => comun.limpiarDoi(i)).filter(Boolean))]
      .filter((d) => FORMA_DEL_DOI.test(d))
      .slice(0, 25);
    if (!validos.length) return [];

    const juntos = validos.filter((d) => !d.includes(','));
    const sueltos = validos.filter((d) => d.includes(','));

    const obras = [];
    if (juntos.length) {
      const url = new URL(BASE);
      url.searchParams.set('filter', juntos.map((d) => `doi:${d}`).join(','));
      url.searchParams.set('rows', String(juntos.length));
      url.searchParams.set('select', CAMPOS);
      const res = await comun.pedir(firmar(url), { base: NOMBRE });
      if (res?.ok) obras.push(...(res.json?.message?.items ?? []));
    }
    obras.push(...(await Promise.all(sueltos.map(unaPorDoi))).filter(Boolean));

    // Crossref no distingue mayúsculas en los DOI: se compara en minúsculas.
    const pedidos = new Set(validos.map((d) => d.toLowerCase()));
    return obras
      .map(comoFicha)
      .filter((f) => f && pedidos.has(f.doi.toLowerCase()));
  } catch {
    return [];
  }
}

module.exports = {
  clave: 'crossref',
  nombre: 'Crossref',
  detalle: 'Todo lo que tiene DOI, de cualquier editorial',
  activa: () => true,
  buscar,
  porIds,
};
