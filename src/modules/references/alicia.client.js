'use strict';

const logger = require('../../config/logger');

const BASE = 'https://alicia.concytec.gob.pe/vufind/api/v1';

/**
 * ALICIA, el repositorio nacional del CONCYTEC.
 *
 * POR QUÉ ESTE CATÁLOGO
 * ---------------------
 * Porque es donde están los antecedentes nacionales. ALICIA recoge los
 * repositorios de todas las universidades peruanas —y con ellos RENATI, las
 * tesis que se registran en la SUNEDU— más las revistas de esas universidades.
 * Ni Scopus ni OpenAlex tienen las tesis de pregrado y maestría, y son
 * justamente lo que el asesor pide cuando dice «faltan antecedentes
 * nacionales».
 *
 * Es un VuFind con su API REST abierta: sin clave, sin cuota publicada y con
 * el mismo lenguaje de búsqueda que se usa en su web (AND, OR, NOT, comillas
 * y paréntesis; no distingue tildes). Los registros son de acceso abierto y se
 * cosechan por OAI-PMH, así que guardar la ficha no choca con ninguna
 * licencia, al revés que con Scopus.
 *
 * Lo que NO tiene: DOI casi nunca, ni recuento de citas. Por eso no se mezcla
 * con la tabla de Scopus, que ordena por citas; va en su propio bloque.
 */

/** Cuánto se espera como mucho. Es un servicio del Estado y a veces va lento. */
const TIEMPO_LIMITE_MS = 15_000;

/** Los que se enseñan por página. */
const POR_PAGINA = 20;

/**
 * Los tipos que se pueden filtrar, con su nombre en el índice de ALICIA.
 *
 * Solo los que le sirven a un tesista como antecedente. Hay más —informes,
 * libros, ponencias— y siguen saliendo con «Todos».
 */
const TIPOS = {
  pregrado: 'bachelorThesis',
  maestria: 'masterThesis',
  doctorado: 'doctoralThesis',
  articulos: 'article',
};

/** Cómo se nombra cada formato al tesista. */
const NOMBRE_DEL_TIPO = {
  bachelorThesis: 'Tesis de pregrado',
  masterThesis: 'Tesis de maestría',
  doctoralThesis: 'Tesis doctoral',
  article: 'Artículo',
  report: 'Informe',
  book: 'Libro',
  bookPart: 'Capítulo de libro',
  conferenceObject: 'Ponencia',
};

/**
 * Su identificador: el acrónimo del repositorio y un hash, `UPAO_820c4089…`.
 *
 * Se comprueba antes de pedir nada con él: viaja en la URL de la API y lo
 * manda el navegador.
 */
function esId(id) {
  return /^[A-Za-z0-9]{2,30}_[A-Za-z0-9]{8,64}$/.test(String(id ?? ''));
}

async function pedir(ruta, params) {
  const url = new URL(`${BASE}${ruta}`);
  for (const [clave, valor] of params) url.searchParams.append(clave, valor);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
  });

  if (!res.ok) {
    logger.warn({ estado: res.status, ruta }, 'ALICIA no contestó bien');
    throw new Error(`ALICIA respondió ${res.status}`);
  }

  const json = await res.json();
  if (json.status && json.status !== 'OK') throw new Error(`ALICIA: ${json.status}`);
  return json;
}

/** El primero de una lista del registro, o nada. */
const primero = (valor) => {
  const texto = Array.isArray(valor) ? valor.find((v) => String(v ?? '').trim()) : valor;
  return texto ? String(texto).trim() : null;
};

/** Un campo de Dublin Core del registro, venga con el idioma que venga. */
function campoDc(raw, prefijo) {
  for (const [clave, valor] of Object.entries(raw ?? {})) {
    if (clave.startsWith(`${prefijo}.`) && clave.endsWith('.fl_str_mv')) {
      const texto = primero(valor);
      if (texto) return texto;
    }
  }
  return null;
}

/**
 * Los nombres van ya como «Apellido Apellido, Nombre», que es como se guardan
 * aquí. Unos pocos repositorios los cargaron al revés —«Gady, Alderete
 * Güere»— y no hay forma segura de saberlo desde fuera: se dejan como vienen.
 */
function autores(raw) {
  const lista = raw?.author?.length ? raw.author : raw?.['dc.creator.none.fl_str_mv'] ?? [];
  return lista
    .map((nombre) => String(nombre).replace(/\s+,/g, ',').replace(/\.$/, '').trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('; ');
}

/**
 * La revista de un artículo, sacada de `dc.source`: «Educación; No. 13 (2007):
 * Educación: Revista de la Facultad…; 61-64». Lo primero es el nombre.
 */
function revista(raw) {
  const fuente = (raw?.['dc.source.none.fl_str_mv'] ?? []).find(
    (s) => !/^(reponame|instname|instacron):/.test(s),
  );
  return fuente ? fuente.split(';')[0].trim() : null;
}

/** Las palabras clave del autor, sin los códigos OCDE que vienen mezclados. */
function etiquetas(raw) {
  return (raw?.topic ?? [])
    .filter((t) => !/^https?:/.test(t))
    .slice(0, 12)
    .join(', ');
}

/**
 * De un registro de ALICIA a la ficha que usa todo lo demás.
 *
 * `rawData` es el documento de Solr tal cual: es donde están la universidad,
 * el asesor y la revista, que los campos «bonitos» de la API dejan vacíos en
 * la mitad de los repositorios. El resumen llega aparte, en `summary`.
 */
function comoFicha(registro) {
  const raw = registro.rawData ?? {};
  const formato = primero(raw.format) ?? 'other';
  const esTesis = /Thesis$/.test(formato);
  const universidad = raw.instname_str ?? campoDc(raw, 'dc.publisher') ?? null;
  const anio = Number.parseInt(primero(raw.publishDate) ?? '', 10);

  return {
    id: raw.id ?? registro.id,
    title: String(raw.title ?? '').trim().replace(/\.$/, '') || null,
    authors: autores(raw),
    year: Number.isFinite(anio) ? anio : null,
    // En una tesis, `source` es la universidad: así la cita la plantilla
    // («[Tesis de maestría, Universidad…]»). En un artículo, la revista.
    source: esTesis ? universidad : revista(raw) ?? universidad,
    universidad,
    formato,
    tipo: NOMBRE_DEL_TIPO[formato] ?? 'Otro',
    // Tal cual: `project.csl.tipoCsl` ve «thesis» en los tres de tesis, y
    // `generoDeTesis` saca de aquí el «Tesis de maestría» que pide APA.
    itemType: formato,
    asesor: campoDc(raw, 'dc.contributor.advisor'),
    url: primero(raw.url),
    abstract: primero(registro.summary ?? raw.description) || null,
    tags: etiquetas(raw),
  };
}

/** Pide los campos que hacen falta para la ficha y nada más. */
const CAMPOS = [
  ['field[]', 'rawData'],
  ['field[]', 'summary'],
];

/**
 * Busca en ALICIA.
 *
 * `consulta` va ya en su lenguaje —ver `scopus.alicia.consultaParaAlicia`—.
 * `tipos` son claves de `TIPOS`; varias se juntan con OR (el `~` de VuFind).
 * `desde` y `hasta` son años.
 */
async function buscar({ consulta, pagina = 1, tipos = [], desde = null, hasta = null }) {
  const params = [
    ['lookfor', consulta],
    ['type', 'AllFields'],
    ['limit', String(POR_PAGINA)],
    ['page', String(Math.max(1, pagina))],
    ['sort', 'relevance'],
    ...CAMPOS,
  ];

  for (const tipo of tipos) {
    if (TIPOS[tipo]) params.push(['filter[]', `~format:"${TIPOS[tipo]}"`]);
  }
  if (desde || hasta) {
    params.push(['filter[]', `publishDate:[${desde ?? '*'} TO ${hasta ?? '*'}]`]);
  }

  const json = await pedir('/search', params);
  return {
    total: json.resultCount ?? 0,
    fichas: (json.records ?? []).map(comoFicha).filter((f) => f.id && f.title),
  };
}

/** Varias fichas por su identificador, en una sola petición. */
async function porIds(ids) {
  const validos = ids.filter(esId);
  if (validos.length === 0) return [];

  const json = await pedir('/record', [...validos.map((id) => ['id[]', id]), ...CAMPOS]);
  return (json.records ?? []).map(comoFicha).filter((f) => f.id && f.title);
}

module.exports = { buscar, porIds, esId, comoFicha, POR_PAGINA, TIPOS };
