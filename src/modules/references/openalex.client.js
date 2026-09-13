'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');

const BASE = 'https://api.openalex.org/works';

/**
 * Búsqueda en vivo en OpenAlex.
 *
 * POR QUÉ ESTO Y NO LA API DE SCOPUS
 * ----------------------------------
 * Porque la de Scopus no se puede usar desde aquí. Elsevier ata el acceso de
 * verdad a la RED de una institución suscrita: la clave se registra gratis, pero
 * desde la IP de un servidor en Hetzner no hay suscripción que valga y lo que
 * devuelve es metadato recortado o nada. Es el mismo muro que obliga a entrar
 * por la VPN de la universidad para leer un artículo.
 *
 * OpenAlex cubre el mismo terreno —327 millones de trabajos— sin clave y sin
 * cuota institucional, e indexa Scielo, Redalyc y repositorios latinoamericanos
 * que Scopus ni siquiera tiene. Para un tesista peruano que necesita
 * antecedentes nacionales, eso no es un consuelo: es mejor.
 *
 * Lo que sí pierde: sus palabras clave las asigna un clasificador, no un autor.
 * Da igual aquí —se busca sobre título y resumen— pero importa en el análisis
 * bibliométrico, y por eso allí se declara.
 */

/** Cuánto se espera como mucho. Va dentro de un turno de conversación. */
const TIEMPO_LIMITE_MS = 12_000;

/**
 * El correo identifica la petición y da acceso al grupo de tráfico rápido.
 *
 * No es cortesía: sin él, OpenAlex sirve por la cola lenta y la búsqueda tarda
 * lo bastante como para que el tesista crea que el conector se colgó.
 */
function contacto() {
  return env.OPENALEX_MAILTO || env.MAIL_FROM;
}

/**
 * Rehace el resumen desde el índice invertido.
 *
 * OpenAlex no guarda el resumen como texto seguido: guarda cada palabra con las
 * posiciones donde aparece, por cómo están licenciados los resúmenes. Deshacerlo
 * es contar hasta la posición más alta y colocar cada palabra en su sitio.
 *
 * Sin esto, el tesista recibiría una ficha sin resumen, que es media ficha: por
 * el resumen es por donde decide si la fuente le sirve.
 */
function resumenDelIndice(indice) {
  if (!indice || typeof indice !== 'object') return null;

  const palabras = [];
  for (const [palabra, posiciones] of Object.entries(indice)) {
    for (const posicion of posiciones) palabras[posicion] = palabra;
  }

  const texto = palabras.filter(Boolean).join(' ').trim();
  return texto || null;
}

/** Autores en formato de cita, igual que los del fondo de la casa. */
/** «45-62» a partir de las dos puntas que da OpenAlex. */
function paginas(biblio) {
  const desde = biblio?.first_page ?? null;
  const hasta = biblio?.last_page ?? null;
  if (desde && hasta) return desde === hasta ? String(desde) : `${desde}-${hasta}`;
  return desde ? String(desde) : null;
}

/**
 * De una obra de OpenAlex a la ficha que usa todo lo demás.
 *
 * Una sola función para las cuatro consultas —por DOI, por lote de DOI, por
 * identificador y «quién cita a»— porque el día que se añada un campo hay que
 * añadirlo una vez. Ya pasó lo contrario con el formateo de las citas.
 */
function comoFicha(w) {
  return {
    /** El de OpenAlex. Hace falta para contar cuántas fuentes suyas la citan. */
    id: w.id,
    doi: limpiarDoi(w.doi),
    title: w.title,
    authors: autores(w.authorships) || '',
    year: w.publication_year ?? null,
    source: w.primary_location?.source?.display_name ?? null,
    // OpenAlex los agrupa en `biblio`, y los da como texto. Vienen vacíos a
    // menudo —sobre todo en lo recién publicado—; lo que falte se completa
    // después contra Crossref, que es donde el editor los depositó.
    volume: w.biblio?.volume ?? null,
    issue: w.biblio?.issue ?? null,
    pages: paginas(w.biblio),
    url: w.best_oa_location?.pdf_url ?? w.doi ?? null,
    abstract: resumenDelIndice(w.abstract_inverted_index),
    /** Las asigna un clasificador, no el autor. Sirven para buscar, no para citar. */
    tags: (w.keywords ?? [])
      .map((k) => k.display_name)
      .filter(Boolean)
      .slice(0, 12)
      .join(', '),
    /** El tipo tal como lo dice OpenAlex, para que el `.bib` lo traduzca. */
    itemType: w.type ?? 'article',
    /** Cuántas veces la han citado. Ordena la bola de nieve hacia delante. */
    citas: w.cited_by_count ?? 0,
  };
}

/** Países donde lo normal es nombre y DOS apellidos: «Rosa Isabel Tecocha Portocarrero». */
const DOS_APELLIDOS = new Set([
  'AR', 'BO', 'BR', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'ES', 'GT', 'HN', 'MX',
  'NI', 'PA', 'PE', 'PR', 'PT', 'PY', 'SV', 'UY', 'VE',
]);

/** Van con el apellido que las sigue: «Juan de la Cruz» → «de la Cruz». */
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'van', 'von', 'der', 'den', 'di', 'du', 'le']);

/** «F.», «F», «J.-P.»: una inicial del nombre, nunca un apellido. */
const INICIAL = /^\p{Lu}\.?(-\p{Lu}\.?)?$/u;

/**
 * Un nombre de OpenAlex, en «Apellido, I.».
 *
 * OpenAlex da el nombre entero —«David F. Larcker»— y no dice dónde empieza el
 * apellido, así que hay que decidirlo. Antes se tomaba la primera palabra como
 * nombre y todo lo demás como apellido, y así salieron a la bibliografía
 * «F. Larcker, D.», «M. Podsakoff, P.» o «Sugey Román-Córdova, V.». Las reglas,
 * en orden:
 *
 *   1. Una inicial es del nombre: el apellido empieza después de la última.
 *   2. Si el autor es de un país de dos apellidos, o no se sabe de dónde es:
 *      un último apellido con guion va solo («Vanessa Sugey Román-Córdova»);
 *      con cuatro palabras o más, los dos últimos son los apellidos; con tres,
 *      las dos últimas («Christian Díaz Peralta»).
 *   3. Si se sabe que es de otro sitio, el apellido es la última palabra.
 *
 * Nunca es perfecto —un nombre no dice su estructura—, y por eso lo que se
 * GUARDA para citar prefiere los autores de Crossref, que el editor depositó ya
 * separados. Esto es para lo que se enseña en una búsqueda.
 */
function nombreApa(nombreCompleto, paises = []) {
  if (!nombreCompleto) return null;
  const partes = String(nombreCompleto).trim().split(/\s+/);
  if (partes.length === 1) return partes[0];

  let inicio;
  const ultimaInicial = partes.reduce((i, parte, j) => (INICIAL.test(parte) ? j : i), -1);

  if (ultimaInicial >= 0 && ultimaInicial < partes.length - 1) {
    inicio = ultimaInicial + 1;
  } else {
    const conocidos = (paises ?? []).map((p) => String(p).toUpperCase());
    const dosApellidos = conocidos.length === 0 || conocidos.some((p) => DOS_APELLIDOS.has(p));

    if (!dosApellidos) inicio = partes.length - 1;
    else if (partes.length >= 3 && partes.at(-1).includes('-')) inicio = partes.length - 1;
    else if (partes.length >= 4) inicio = partes.length - 2;
    else inicio = 1;
  }

  // Las partículas que preceden al apellido son parte de él.
  while (inicio > 1 && PARTICULAS.has(partes[inicio - 1].toLowerCase())) inicio -= 1;

  return `${partes.slice(inicio).join(' ')}, ${partes[0].charAt(0)}.`;
}

function autores(authorships = []) {
  return authorships
    .slice(0, 8)
    .map((a) => {
      return nombreApa(a?.author?.display_name, a?.countries);
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * Busca y devuelve fichas ya listas para citar.
 *
 * `idioma` y `pais` son lo que hace útil esto para una tesis peruana: los
 * antecedentes nacionales se piden acotando por país, que es exactamente la
 * pregunta del jurado —«¿y qué se ha estudiado sobre esto en el Perú?»— y la
 * que el fondo de la casa no puede responder porque es casi todo en inglés.
 */
/**
 * Una página de resultados, o null si OpenAlex no contestó.
 *
 * `enTituloYResumen` decide dónde se busca: con él, la palabra tiene que estar
 * en el título o el resumen; sin él, OpenAlex busca también en el texto
 * completo, y ahí «Lima» y «compra» aparecen en casi cualquier artículo peruano.
 */
async function paginaDeBusqueda({ tema, idioma, pais, desdeAnio, cuantas, enTituloYResumen }) {
  const url = new URL(BASE);
  if (!enTituloYResumen) url.searchParams.set('search', tema);
  url.searchParams.set('per_page', String(Math.min(Math.max(cuantas, 1), 25)));
  url.searchParams.set('mailto', contacto());

  const filtros = ['type:article'];
  if (idioma) filtros.push(`language:${idioma}`);
  if (pais) filtros.push(`authorships.institutions.country_code:${pais.toLowerCase()}`);
  if (desdeAnio) filtros.push(`from_publication_date:${desdeAnio}-01-01`);
  // Las comas separan filtros en OpenAlex: dentro del tema romperían la consulta.
  if (enTituloYResumen) filtros.push(`title_and_abstract.search:${tema.replace(/,/g, ' ')}`);
  url.searchParams.set('filter', filtros.join(','));

  const corte = AbortSignal.timeout(TIEMPO_LIMITE_MS);
  const res = await fetch(url, { signal: corte }).catch((error) => {
    logger.warn({ err: error, tema }, 'OpenAlex no respondió a tiempo');
    return null;
  });

  if (!res) return null;

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    // La búsqueda anónima de OpenAlex se pausa a veces mientras su servidor se
    // recupera; los filtros siguen funcionando. No es culpa de nadie y no debe
    // parecer un fallo del conector.
    logger.warn({ estado: res.status, detalle: detalle.slice(0, 160) }, 'OpenAlex rechazó la búsqueda');
    return null;
  }

  return res.json();
}

/**
 * Busca en OpenAlex, primero en título y resumen y después, si no llega, en
 * todo.
 *
 * Solo con la búsqueda completa, «experiencia de compra comercio electrónico
 * Lima» devolvía el 13 de septiembre de 2026 evasión tributaria en San Martín y
 * cajas municipales de Áncash. Solo con título y resumen, la misma frase daba un
 * único resultado, porque exige cada palabra. Las dos juntas: lo relevante
 * delante y lo amplio detrás, sin repetir.
 */
async function buscar({ tema, idioma = null, pais = null, desdeAnio = null, cuantas = 6 }) {
  const comun = { tema, idioma, pais, desdeAnio, cuantas };

  const precisa = await paginaDeBusqueda({ ...comun, enTituloYResumen: true });
  let resultados = precisa?.results ?? [];
  let total = precisa?.meta?.count ?? 0;

  if (resultados.length < cuantas) {
    const amplia = await paginaDeBusqueda({ ...comun, enTituloYResumen: false });
    if (!precisa && !amplia) return { fuentes: [], total: 0, caida: true };

    const vistos = new Set(resultados.map((w) => w.id));
    const extra = (amplia?.results ?? []).filter((w) => !vistos.has(w.id));
    resultados = [...resultados, ...extra].slice(0, cuantas);
    total = Math.max(total, amplia?.meta?.count ?? 0);
  }

  const datos = { results: resultados, meta: { count: total } };

  const fuentes = (datos.results ?? []).map((w) => ({
    titulo: w.title ?? '(sin título)',
    autores: autores(w.authorships) || '(Autor no consignado)',
    anio: w.publication_year ?? null,
    revista: w.primary_location?.source?.display_name ?? null,
    doi: w.doi ? String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null,
    citas: w.cited_by_count ?? 0,
    idioma: w.language ?? null,
    /** Si hay PDF libre. El tesista puede leerlo entero, no solo el resumen. */
    pdfLibre: w.best_oa_location?.pdf_url ?? null,
    resumen: resumenDelIndice(w.abstract_inverted_index),
  }));

  return { fuentes, total: datos.meta?.count ?? fuentes.length, caida: false };
}

/** Un DOI limpio, venga como identificador o como enlace. */
function limpiarDoi(crudo) {
  const valor = String(crudo ?? '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '');

  // La forma de un DOI es estable desde hace veinte años: 10.registro/sufijo.
  return /^10\.\d{4,9}\/\S+$/.test(valor) ? valor : null;
}

/**
 * La ficha de UN trabajo, por su DOI.
 *
 * Es lo que convierte «tengo una carpeta de PDFs» en fuentes citables: del
 * archivo solo hace falta sacar el DOI —veinte caracteres— y los metadatos
 * buenos llegan de aquí. Nadie interpreta el maquetado a dos columnas de un
 * artículo, ni adivina dónde acaba el título, ni pelea con las ligaduras.
 *
 * Y el resumen viene de OpenAlex, no del archivo. Por esta vía no existe el
 * problema de «Abstract & keywords» del export de Scopus: no hay ninguna
 * casilla que el tesista pueda olvidar marcar.
 *
 * Devuelve null cuando el DOI no está indexado, que es raro pero pasa. Quien
 * llame tiene que decírselo al tesista, no callarlo: un archivo que desaparece
 * sin explicación es peor que uno que se rechaza.
 */
async function porDoi(crudo) {
  const doi = limpiarDoi(crudo);
  if (!doi) return null;

  const url = new URL(`${BASE}/doi:${encodeURIComponent(doi)}`);
  url.searchParams.set('mailto', contacto());

  const res = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }).catch(
    (error) => {
      logger.warn({ err: error, doi }, 'OpenAlex no respondió al pedir un DOI');
      return null;
    },
  );

  // El 404 es información, no un fallo: ese DOI no está en OpenAlex y no lo va
  // a estar por reintentar. Se distingue de una caída para que quien llame
  // pueda decir cosas distintas.
  if (!res) return null;
  if (res.status === 404) return null;

  if (!res.ok) {
    logger.warn({ estado: res.status, doi }, 'OpenAlex rechazó la consulta por DOI');
    return null;
  }

  const w = await res.json().catch(() => null);
  if (!w || !w.title) return null;

  return comoFicha(w);
}

/**
 * Cuántos valores caben en un filtro con «|».
 *
 * OpenAlex admite hasta 50 por grupo. Es lo que convierte la bola de nieve en
 * tres peticiones en vez de ciento cincuenta.
 */
const POR_FILTRO = 50;

const enLotes = (lista, tamano) => {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
};

/** Una consulta de lista, con su manejo de caídas. Devuelve [] si no responde. */
async function consultar(params) {
  const url = new URL(BASE);
  for (const [clave, valor] of Object.entries(params)) url.searchParams.set(clave, valor);
  url.searchParams.set('mailto', contacto());

  const res = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }).catch(
    (error) => {
      logger.warn({ err: error }, 'OpenAlex no respondió a tiempo');
      return null;
    },
  );

  if (!res || !res.ok) {
    if (res) logger.warn({ estado: res.status }, 'OpenAlex rechazó la consulta');
    return [];
  }

  const datos = await res.json().catch(() => null);
  return datos?.results ?? [];
}

/**
 * A quién cita cada una de estas fuentes.
 *
 * Se piden en lotes de cincuenta y solo tres campos: con `select` la respuesta
 * de cincuenta obras son unos kilobytes, y sin él vienen los resúmenes enteros
 * de todas.
 */
async function referenciasDe(dois) {
  const limpios = dois.map(limpiarDoi).filter(Boolean);
  const obras = [];

  for (const lote of enLotes(limpios, POR_FILTRO)) {
    const resultados = await consultar({
      filter: `doi:${lote.join('|')}`,
      select: 'id,doi,referenced_works',
      'per-page': String(POR_FILTRO),
    });

    for (const w of resultados) {
      obras.push({
        id: w.id,
        doi: limpiarDoi(w.doi),
        referencias: w.referenced_works ?? [],
      });
    }
  }

  return obras;
}

/** Las fichas de una lista de identificadores de OpenAlex. */
async function porIds(ids) {
  const fichas = [];

  for (const lote of enLotes(ids, POR_FILTRO)) {
    const resultados = await consultar({
      filter: `ids.openalex:${lote.map(soloElId).join('|')}`,
      'per-page': String(POR_FILTRO),
    });
    for (const w of resultados) if (w.title) fichas.push(comoFicha(w));
  }

  return fichas;
}

/**
 * Los trabajos que citan a alguna de estas obras, de lo más nuevo a lo más viejo.
 *
 * Todas las semillas caben en un solo filtro, así que esto es UNA petición y no
 * una por fuente. El orden por fecha es el que importa aquí: la bola de nieve
 * hacia delante sirve para no quedarse en 2019, y para eso lo último es lo
 * primero.
 */
async function citanA(ids, { desdeAnio = null, cuantas = 10 } = {}) {
  if (ids.length === 0) return [];

  const filtros = [`cites:${ids.slice(0, POR_FILTRO).map(soloElId).join('|')}`];
  if (desdeAnio) filtros.push(`from_publication_date:${desdeAnio}-01-01`);

  const resultados = await consultar({
    filter: filtros.join(','),
    sort: 'publication_date:desc',
    'per-page': String(Math.min(Math.max(cuantas, 1), 50)),
  });

  return resultados.filter((w) => w.title).map(comoFicha);
}

/** «https://openalex.org/W123» → «W123». El filtro quiere el corto. */
const soloElId = (id) => String(id).replace(/^https?:\/\/openalex\.org\//i, '');

module.exports = {
  buscar,
  porDoi,
  referenciasDe,
  porIds,
  citanA,
  limpiarDoi,
  nombreApa,
  resumenDelIndice,
  soloElId,
};
