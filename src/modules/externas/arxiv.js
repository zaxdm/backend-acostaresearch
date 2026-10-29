'use strict';

/** arXiv tarda más de 10 s en lo que no tiene en caché (28-oct-2026: 14,5 s). */
const ESPERA_ARXIV_MS = 20_000;

/**
 * arXiv: preprints de física, matemáticas, informática, estadística, economía
 * y biología cuantitativa, todos con su PDF abierto.
 *
 * La API contesta en Atom (XML). Se lee con expresiones regulares sencillas y
 * no con un analizador: el formato es plano, fijo desde hace años, y así no se
 * añade una dependencia por una sola base.
 *
 * Entiende AND/OR/ANDNOT y comillas, pero cada término necesita su campo
 * (`all:`, `ti:`, `abs:`…): la booleana del buscador se traduce poniendo
 * `all:` delante de cada término. arXiv pide no pasar de una petición cada 3 s.
 */

const comun = require('./comun');

// El http:// de la documentación redirige a https:// con un 301.
const API = 'https://export.arxiv.org/api/query';

/** Nuevo («2207.01490», «2207.01490v2») o antiguo («hep-th/9901001»). */
const ID_VALIDO = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;

/** El texto de la primera etiqueta `<nombre …>…</nombre>` del trozo, o null. */
function etiqueta(xml, nombre) {
  const m = xml.match(new RegExp(`<${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</${nombre}>`));
  return m ? m[1] : null;
}

/** Los `href` de los `<link …/>` cuyo atributo cumple `filtro`. */
function enlaceCon(xml, filtro) {
  for (const m of xml.matchAll(/<link\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    if (filtro.test(attrs)) {
      const href = attrs.match(/href="([^"]+)"/);
      if (href) return href[1].replace(/^http:\/\//, 'https://');
    }
  }
  return null;
}

/** «http://arxiv.org/abs/2207.01490v1» → «2207.01490»: sin versión, para que siempre traiga la última. */
function idDe(crudo) {
  const id = String(crudo ?? '')
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    .replace(/v\d+$/, '');
  return ID_VALIDO.test(id) ? id : null;
}

/** Una `<entry>` del Atom, ya desmenuzada. */
function leerEntrada(xml) {
  const id = idDe(etiqueta(xml, 'id'));
  if (!id) return null;
  const autores = [...xml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) =>
    comun.textoLimpio(m[1]),
  );
  return {
    id,
    doi: comun.limpiarDoi(comun.textoLimpio(etiqueta(xml, 'arxiv:doi'))),
    titulo: comun.textoLimpio(etiqueta(xml, 'title')),
    autores,
    anio: comun.anioDe(etiqueta(xml, 'published')),
    revista: comun.textoLimpio(etiqueta(xml, 'arxiv:journal_ref')),
    enlace: enlaceCon(xml, /rel="alternate"/) ?? `https://arxiv.org/abs/${id}`,
    pdf: enlaceCon(xml, /title="pdf"/) ?? `https://arxiv.org/pdf/${id}`,
    resumen: comun.textoLimpio(etiqueta(xml, 'summary')),
  };
}

/**
 * Lee el feed. null si no es un feed o si arXiv devolvió su entrada de error
 * (contesta 200 con una `<entry>` cuyo id apunta a `/api/errors`).
 */
function leerFeed(texto) {
  if (!/<feed\b/.test(texto ?? '')) return null;
  if (/<id>[^<]*\/api\/errors/.test(texto)) return null;
  const total = Number(comun.textoLimpio(etiqueta(texto, 'opensearch:totalResults'))) || 0;
  const entradas = [...texto.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => leerEntrada(m[1])).filter(Boolean);
  return { total, entradas };
}

/**
 * La booleana del buscador en la sintaxis de arXiv: `all:` delante de cada
 * término o frase, y «AND NOT» como su «ANDNOT». Sin booleana, todas las
 * palabras con AND, que es lo que haría arXiv con ellas.
 */
function consultaArxiv(consulta, palabras) {
  const booleana = String(consulta ?? '').trim();
  if (booleana) {
    return booleana
      .replace(/\bAND\s+NOT\b/g, 'ANDNOT')
      .replace(/"[^"]+"|[^\s()"]+/g, (t) => {
        if (t === 'AND' || t === 'OR' || t === 'ANDNOT') return t;
        if (t === 'NOT') return 'ANDNOT';
        return `all:${t}`;
      });
  }
  const sueltas = String(palabras ?? '')
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}\p{N}\-]/gu, ''))
    .filter(Boolean);
  return sueltas.length ? sueltas.map((p) => `all:${p}`).join(' AND ') : null;
}

function comoResultado(e) {
  return {
    id: e.id,
    doi: e.doi,
    titulo: e.titulo ?? '(sin título)',
    autores: comun.autoresApa(e.autores),
    anio: e.anio,
    revista: e.revista ?? 'arXiv',
    idioma: null,
    // arXiv no cuenta citas.
    citas: 0,
    enlace: e.enlace,
    pdfLibre: e.pdf,
    resumen: e.resumen,
    tipo: 'preprint',
  };
}

function comoFicha(e) {
  return {
    id: e.id,
    doi: e.doi,
    title: e.titulo ?? '(sin título)',
    authors: comun.autoresApa(e.autores),
    year: e.anio,
    // Si ya salió en una revista, `journal_ref` lo dice; si no, se cita como arXiv.
    source: e.revista ?? 'arXiv',
    volume: null,
    issue: null,
    pages: null,
    url: e.enlace,
    abstract: e.resumen,
    itemType: 'preprint',
  };
}

async function buscar({ consulta, palabras, pagina = 1, porPagina = 25, desde = null, hasta = null } = {}) {
  let q = consultaArxiv(consulta, palabras);
  if (!q) return comun.CAIDA;
  if (desde || hasta) {
    // Por fecha de envío: arXiv no tiene otra fecha de publicación.
    const inicio = `${desde ?? 1991}01010000`;
    const fin = `${hasta ?? new Date().getFullYear()}12312359`;
    q = `(${q}) AND submittedDate:[${inicio} TO ${fin}]`;
  }

  const limite = Math.min(Math.max(Number(porPagina) || 25, 1), 100);
  const url = new URL(API);
  url.searchParams.set('search_query', q);
  url.searchParams.set('start', String((Math.max(Number(pagina) || 1, 1) - 1) * limite));
  url.searchParams.set('max_results', String(limite));
  url.searchParams.set('sortBy', 'relevance');
  url.searchParams.set('sortOrder', 'descending');

  const res = await comun.pedir(url, { base: 'arXiv', comoTexto: true, tiempoMs: ESPERA_ARXIV_MS });
  if (!res?.ok) return comun.CAIDA;
  const feed = leerFeed(res.texto);
  if (!feed) return comun.CAIDA;

  return { resultados: feed.entradas.map(comoResultado), total: feed.total, caida: false };
}

/** Todos de una vez: `id_list` admite varios separados por comas. */
async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))].filter((i) => ID_VALIDO.test(i)).slice(0, 25);
  if (!validos.length) return [];

  const url = new URL(API);
  url.searchParams.set('id_list', validos.join(','));
  url.searchParams.set('max_results', String(validos.length));

  const res = await comun.pedir(url, { base: 'arXiv', comoTexto: true, tiempoMs: ESPERA_ARXIV_MS });
  if (!res?.ok) return [];
  const feed = leerFeed(res.texto);
  return feed ? feed.entradas.map(comoFicha) : [];
}

module.exports = {
  clave: 'arxiv',
  nombre: 'arXiv',
  detalle: 'Preprints de ciencias, informática y economía',
  activa: () => true,
  buscar,
  porIds,
};
