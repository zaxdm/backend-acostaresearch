'use strict';

const logger = require('../../config/logger');
const { comoFicha, leerJson, POR_PAGINA } = require('./alicia.client');

const BASE = 'https://www.lareferencia.info/vufind/api/v1';

/**
 * LA Referencia, la red latinoamericana de repositorios de acceso abierto.
 *
 * POR QUÉ ESTE CATÁLOGO
 * ---------------------
 * Es el respaldo de ALICIA. El 10-oct-2026 ALICIA pasó de lenta a no contestar
 * («Problem connecting to Solr» a los 35 segundos) y la pestaña de tesis
 * peruanas se quedó vacía toda la mañana. LA Referencia cosecha el nodo
 * peruano —o sea, la propia ALICIA— y lo sirve desde sus servidores: ese día
 * contestaba en menos de un segundo.
 *
 * Es el mismo programa que ALICIA (VuFind) y el registro tiene la misma forma,
 * así que la ficha la arma `alicia.client.comoFicha`. Sin clave y sin cuota
 * publicada.
 *
 * LO QUE NO TIENE, Y ES MUCHO
 * ---------------------------
 * Las tesis de PREGRADO. LA Referencia solo recoge posgrado: de los 312 509
 * registros del Perú, 144 123 son de maestría, 19 906 de doctorado y 108 452
 * artículos; `bachelorThesis`, ninguno. Por eso es respaldo y no sustituto, y
 * por eso la web le dice al tesista de dónde viene lo que ve.
 *
 * Tampoco trae el asesor, ni la revista de un artículo (queda la universidad).
 * Y sus identificadores son otros: `PE_<hash>`, no `UPAO_<hash>`.
 *
 * DOS RAREZAS DE SU API, MEDIDAS EL 10-OCT-2026
 * ---------------------------------------------
 * 1. `type=AllFields`, que es el de siempre y el que usa ALICIA, contesta 400
 *    «Invalid search». Con cualquier otro nombre busca en todos los campos,
 *    que es lo que hace falta (una frase que solo sale en los resúmenes da lo
 *    mismo con `Title`, con `Subject` y con un nombre inventado). Se prueba
 *    primero el bueno, por si lo arreglan, y si lo rechaza se pasa al otro.
 * 2. Sus «report» del Perú son casi todos sílabos de cursos («Lógica - MA473 -
 *    202301»): con «pensamiento crítico», 2246 de 3782. Se dejan fuera.
 */

/** Contesta en medio segundo; diez es de sobra. */
const TIEMPO_LIMITE_MS = 10_000;

/** Lo que va delante del identificador para saber de dónde vino. */
const PREFIJO = 'lareferencia:';

/** Los tipos que tiene. `pregrado` no está: ver arriba. */
const TIPOS = {
  maestria: 'masterThesis',
  doctorado: 'doctoralThesis',
  articulos: 'article',
};

/** Solo el nodo peruano, y sin los sílabos. */
const FILTROS_FIJOS = [
  ['filter[]', 'network_acronym_str:"PE"'],
  ['filter[]', '-format:"report"'],
];

const CAMPOS = [
  ['field[]', 'rawData'],
  ['field[]', 'summary'],
];

/** El tipo de búsqueda que les funciona. Se recuerda hasta el reinicio. */
const TIPO_NORMAL = 'AllFields';
const TIPO_DE_REPUESTO = 'Todo';
let tipoDeBusqueda = TIPO_NORMAL;

/** `lareferencia:PE_e0c6fc05…`, como lo recibe y lo devuelve la web. */
function esId(id) {
  return /^lareferencia:PE_[a-f0-9]{32}$/.test(String(id ?? ''));
}

async function pedir(ruta, params) {
  const url = new URL(`${BASE}${ruta}`);
  for (const [clave, valor] of params) url.searchParams.append(clave, valor);

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
  });

  let json = null;
  try {
    json = leerJson(await res.text());
  } catch {
    // Una página de error en vez de JSON: se cuenta abajo como fallo.
  }

  if (!res.ok || !json || (json.status && json.status !== 'OK')) {
    const motivo = json?.statusMessage ?? json?.status ?? 'sin JSON';
    const fallo = new Error(`LA Referencia respondió ${res.status}: ${motivo}`);
    fallo.busquedaInvalida = res.status === 400 && /invalid search/i.test(String(motivo));
    throw fallo;
  }
  return json;
}

/** La ficha, con el prefijo en el identificador. */
function fichas(json) {
  return (json.records ?? [])
    .map(comoFicha)
    .filter((f) => f.id && f.title)
    .map((f) => ({ ...f, id: `${PREFIJO}${f.id}` }));
}

/**
 * Busca en el nodo peruano. Mismos argumentos que `alicia.client.buscar`, y
 * la consulta va en el mismo lenguaje: es el mismo programa.
 *
 * `pregrado` entre los tipos se ignora: quien llama decide qué hacer si era
 * lo único que se pedía.
 */
async function buscar({ consulta, pagina = 1, tipos = [], desde = null, hasta = null }) {
  const filtros = [...FILTROS_FIJOS];
  for (const tipo of tipos) {
    if (TIPOS[tipo]) filtros.push(['filter[]', `~format:"${TIPOS[tipo]}"`]);
  }
  if (desde || hasta) {
    filtros.push(['filter[]', `publishDate:[${desde ?? '*'} TO ${hasta ?? '*'}]`]);
  }

  const params = (tipo) => [
    ['lookfor', consulta],
    ['type', tipo],
    ['limit', String(POR_PAGINA)],
    ['page', String(Math.max(1, pagina))],
    ['sort', 'relevance'],
    ...filtros,
    ...CAMPOS,
  ];

  let json;
  try {
    json = await pedir('/search', params(tipoDeBusqueda));
  } catch (fallo) {
    if (!fallo.busquedaInvalida || tipoDeBusqueda !== TIPO_NORMAL) throw fallo;
    logger.warn('LA Referencia rechaza AllFields: se busca con el tipo de repuesto');
    tipoDeBusqueda = TIPO_DE_REPUESTO;
    json = await pedir('/search', params(tipoDeBusqueda));
  }

  return { total: json.resultCount ?? 0, fichas: fichas(json) };
}

/** Varias fichas por su identificador (con prefijo), en una sola petición. */
async function porIds(ids) {
  const validos = ids.filter(esId).map((id) => id.slice(PREFIJO.length));
  if (validos.length === 0) return [];

  const json = await pedir('/record', [...validos.map((id) => ['id[]', id]), ...CAMPOS]);
  return fichas(json);
}

module.exports = { buscar, porIds, esId, TIPOS, PREFIJO };
