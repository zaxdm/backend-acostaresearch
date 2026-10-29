'use strict';

/**
 * DBLP (Universidad de Trier y Schloss Dagstuhl): la bibliografía de
 * informática, revistas y congresos, curada a mano.
 *
 * No trae resúmenes ni citas: solo la ficha bibliográfica y el enlace a la
 * editorial. Su buscador no entiende comillas ni paréntesis (los espacios son
 * AND y `|` es OR), así que va con `palabras`. Tampoco filtra por un rango de
 * años: `desde`/`hasta` no se aplican, para no falsear `total` ni la paginación
 * filtrando después.
 */

const comun = require('./comun');

const API = 'https://dblp.org/search/publ/api';
const REGISTRO = 'https://dblp.org/rec';

/** «journals/corr/abs-2207-01490», «conf/aied/FenuGM22»: prefijo y dos o tres tramos, sin «..». */
const ID_VALIDO = /^[a-z]+(\/[A-Za-z0-9_.-]+){1,3}$/;

function idValido(id) {
  return ID_VALIDO.test(id) && !id.includes('..');
}

/** DBLP manda un objeto cuando hay uno solo y una lista cuando hay varios. */
function lista(valor) {
  if (valor == null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

/** «John Smith 0002» → «John Smith»: el número solo distingue homónimos dentro de DBLP. */
function sinHomonimo(nombre) {
  return String(nombre ?? '').replace(/\s+\d{4}$/, '').trim();
}

/** DBLP cierra todos los títulos con punto; en la cita lo pone el estilo. */
function tituloDe(crudo) {
  const t = comun.textoLimpio(crudo);
  return t ? t.replace(/\.$/, '') : null;
}

/** El `tipo` del contrato según el tipo de DBLP (y la clave, para las tesis). */
function tipoDe(tipo, id) {
  switch (tipo) {
    case 'Journal Articles':
      return 'article';
    case 'Informal and Other Publications':
    case 'Informal Publications':
      // Casi todo es CoRR, es decir, arXiv.
      return 'preprint';
    case 'Books and Theses':
      return /^phd\//.test(id ?? '') ? 'dissertation' : 'book';
    case 'Parts in Books or Collections':
      return 'chapter';
    case 'Editorship':
      return 'book';
    default:
      // Congresos, talleres, datos: no hay un tipo mejor en el contrato.
      return 'other';
  }
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

/** La editorial primero; si es arXiv, su PDF abierto sale del mismo enlace. */
function enlaces(ees, registro) {
  const todos = lista(ees).map((e) => String(e ?? '').trim()).filter(Boolean);
  const enlace = todos[0] ?? registro ?? null;
  let pdfLibre = todos.find((e) => /\.pdf($|\?)/i.test(e)) ?? null;
  if (!pdfLibre) {
    const arxiv = todos.map((e) => e.match(/arxiv\.org\/abs\/([^\s?#]+)/i)).find(Boolean);
    if (arxiv) pdfLibre = `https://arxiv.org/pdf/${arxiv[1]}`;
  }
  return { enlace, pdfLibre };
}

function comoResultado(info) {
  const id = String(info.key ?? '');
  const tipo = tipoDe(info.type, id);
  const { enlace, pdfLibre } = enlaces(info.ee, info.url);
  const autores = lista(info.authors?.author).map((a) => sinHomonimo(typeof a === 'string' ? a : a?.text));
  return {
    id,
    doi: comun.limpiarDoi(info.doi),
    titulo: tituloDe(info.title) ?? '(sin título)',
    autores: comun.autoresApa(autores),
    anio: comun.anioDe(info.year),
    revista: comun.textoLimpio(lista(info.venue).join(', ')),
    idioma: null,
    citas: 0,
    enlace,
    pdfLibre,
    resumen: null,
    tipo,
  };
}

async function buscar({ palabras, consulta, pagina = 1, porPagina = 25 } = {}) {
  // Si solo llegó la booleana, se le quitan comillas, paréntesis y operadores.
  const texto = String(palabras || consulta || '')
    .replace(/["()]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!texto) return comun.CAIDA;

  const limite = Math.min(Math.max(Number(porPagina) || 25, 1), 100);
  const url = new URL(API);
  url.searchParams.set('q', texto);
  url.searchParams.set('format', 'json');
  url.searchParams.set('h', String(limite));
  url.searchParams.set('f', String((Math.max(Number(pagina) || 1, 1) - 1) * limite));

  // Si DBLP pone su página anti-robots (Anubis, HTML con 202), `pedir` no
  // puede leer JSON y devuelve null: cuenta como caída.
  const res = await comun.pedir(url, { base: 'DBLP' });
  const hits = res?.ok ? res.json?.result?.hits : null;
  if (!hits) return comun.CAIDA;

  const resultados = lista(hits.hit)
    .map((h) => h?.info)
    .filter((info) => info?.key)
    .map(comoResultado);
  return { resultados, total: Number(hits['@total']) || resultados.length, caida: false };
}

/**
 * El XML de un registro va en US-ASCII: «López» llega como «L&#243;pez», y
 * `comun.textoLimpio` solo conoce las entidades con nombre.
 */
function texto(crudo) {
  const decodificado = String(crudo ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  return comun.textoLimpio(decodificado);
}

/** El texto de la primera etiqueta `<nombre …>…</nombre>`, o null. */
function etiqueta(xml, nombre) {
  const m = xml.match(new RegExp(`<${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</${nombre}>`));
  return m ? texto(m[1]) : null;
}

/** Del XML del registro al tipo de la búsqueda, para reutilizar `tipoDe`. */
const TIPO_XML = {
  article: 'Journal Articles',
  inproceedings: 'Conference and Workshop Papers',
  incollection: 'Parts in Books or Collections',
  book: 'Books and Theses',
  phdthesis: 'Books and Theses',
  mastersthesis: 'Books and Theses',
  proceedings: 'Editorship',
};

/**
 * La ficha desde `https://dblp.org/rec/<clave>.xml`. Es XML plano de un solo
 * registro; se lee con expresiones regulares, igual que arXiv.
 */
function fichaDelXml(xml, id) {
  const raiz = xml.match(/<dblp>\s*<(\w+)\b([^>]*)>([\s\S]*?)<\/\1>/);
  if (!raiz) return null;
  const [, elemento, attrs, cuerpo] = raiz;
  const informal = /publtype="informal"/.test(attrs);
  const tipo = informal ? 'preprint' : tipoDe(TIPO_XML[elemento], id);
  const autores = [...cuerpo.matchAll(/<(?:author|editor)\b[^>]*>([\s\S]*?)<\/(?:author|editor)>/g)].map((m) =>
    sinHomonimo(texto(m[1])),
  );
  const ees = [...cuerpo.matchAll(/<ee\b[^>]*>([\s\S]*?)<\/ee>/g)].map((m) => texto(m[1]));
  const doi = ees.map((e) => comun.limpiarDoi(e)).find(Boolean) ?? null;
  const { enlace } = enlaces(ees, `${REGISTRO}/${id}`);
  return {
    id,
    doi,
    title: tituloDe(etiqueta(cuerpo, 'title')) ?? '(sin título)',
    authors: comun.autoresApa(autores),
    year: comun.anioDe(etiqueta(cuerpo, 'year')),
    source: etiqueta(cuerpo, 'journal') ?? etiqueta(cuerpo, 'booktitle') ?? etiqueta(cuerpo, 'publisher'),
    volume: etiqueta(cuerpo, 'volume'),
    issue: etiqueta(cuerpo, 'number'),
    pages: etiqueta(cuerpo, 'pages'),
    url: enlace,
    abstract: null,
    itemType: ITEM_TYPE[tipo],
  };
}

async function porIds(ids = []) {
  const validos = [...new Set((ids ?? []).map((i) => String(i ?? '').trim()))].filter(idValido).slice(0, 25);
  const fichas = [];
  // En fila: DBLP corta con 429 (y un minuto de castigo) a quien pide en ráfaga.
  for (const id of validos) {
    const res = await comun.pedir(`${REGISTRO}/${id}.xml`, { base: 'DBLP', comoTexto: true });
    const ficha = res?.ok ? fichaDelXml(res.texto ?? '', id) : null;
    if (ficha) fichas.push(ficha);
  }
  return fichas;
}

module.exports = {
  clave: 'dblp',
  nombre: 'DBLP',
  detalle: 'Informática: revistas y congresos',
  // Apagada: el 28-oct-2026 DBLP contestaba con un desafío anti-robots (Anubis,
  // 202 con HTML) también desde el servidor. Lo de informática entra igual por
  // OpenAlex y arXiv. Para volver a probarla: `DBLP_ACTIVA=1` en el `.env`.
  activa: () => comun.clave('DBLP_ACTIVA') === '1',
  buscar,
  porIds,
};
