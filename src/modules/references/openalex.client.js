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
 * Identifica la petición: correo siempre y clave si la hay.
 *
 * Desde 2026 OpenAlex no mide por peticiones sino por un presupuesto diario en
 * dólares, y sin clave son diez centavos POR IP: unas cien búsquedas. Todas las
 * de todos los tesistas salen de la misma IP del servidor, así que el
 * presupuesto se acababa pronto y cada búsqueda volvía rechazada hasta la
 * medianoche UTC —el «catálogo abierto no responde» que no se iba nunca—. La
 * clave gratuita lo multiplica por diez.
 */
function firmar(url) {
  url.searchParams.set('mailto', contacto());
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url;
}

/** Deja en el registro por qué rechazó OpenAlex, sin la clave. */
function avisarRechazo(res, contexto, mensaje) {
  logger.warn(
    {
      ...contexto,
      estado: res.status,
      restanteUsd: res.headers?.get?.('x-ratelimit-remaining-usd') ?? null,
      conClave: Boolean(env.OPENALEX_API_KEY),
    },
    res.status === 429 ? 'OpenAlex: presupuesto diario agotado' : mensaje,
  );
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
  firmar(url);

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
    avisarRechazo(res, { detalle: detalle.slice(0, 160) }, 'OpenAlex rechazó la búsqueda');
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
  firmar(url);

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
    avisarRechazo(res, { doi }, 'OpenAlex rechazó la consulta por DOI');
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
  firmar(url);

  const res = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }).catch(
    (error) => {
      logger.warn({ err: error }, 'OpenAlex no respondió a tiempo');
      return null;
    },
  );

  if (!res || !res.ok) {
    if (res) avisarRechazo(res, {}, 'OpenAlex rechazó la consulta');
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

/**
 * Los resúmenes de una lista de DOI, en una sola consulta por lote.
 *
 * Para el resumen con IA del buscador de Scopus: con nuestra clave Scopus no
 * da el resumen, y OpenAlex sí, en abierto. Solo dos campos, para no traerse
 * la obra entera de cada una. Devuelve un `Map` de DOI en minúsculas a su
 * resumen; los que OpenAlex no conoce, o conoce sin resumen, no están.
 */
async function resumenesPorDoi(dois) {
  const limpios = [...new Set(dois.map(limpiarDoi).filter(Boolean))];
  const resumenes = new Map();

  for (const lote of enLotes(limpios, POR_FILTRO)) {
    const resultados = await consultar({
      filter: `doi:${lote.join('|')}`,
      select: 'doi,abstract_inverted_index',
      'per-page': String(POR_FILTRO),
    });
    for (const w of resultados) {
      const doi = limpiarDoi(w.doi);
      const resumen = resumenDelIndice(w.abstract_inverted_index);
      if (doi && resumen) resumenes.set(doi.toLowerCase(), resumen);
    }
  }

  return resumenes;
}

/**
 * Dónde se lee gratis, y legalmente, cada uno de estos DOI.
 *
 * POR QUÉ HACÍA FALTA
 * -------------------
 * Scopus ya dice si un artículo es de acceso abierto —el `openaccessFlag` que
 * pinta la etiqueta «Acceso abierto» en la tabla— pero NO dice dónde está la
 * copia. El tesista veía el cartel y seguía sin poder leer el artículo: le
 * quedaba ir a la editorial, chocarse con el muro de pago y buscarlo a mano.
 * Esto cierra ese hueco con lo que OpenAlex ya sabe y da en abierto.
 *
 * Solo dos campos por obra, como en `resumenesPorDoi` y por lo mismo: una
 * página son veinticinco DOI y sin `select` vendrían veinticinco obras enteras
 * con sus resúmenes y sus listas de citas.
 *
 * QUÉ DEVUELVE, Y POR QUÉ LA VERSIÓN NO ES UN DETALLE
 * ---------------------------------------------------
 * Una copia abierta no siempre es EL artículo. OpenAlex distingue tres, y la
 * diferencia le importa a quien está citando:
 *
 *   · `publishedVersion` — la del editor. Se cita sin más.
 *   · `acceptedVersion`  — el manuscrito aceptado: mismo contenido, otra
 *     maquetación. Sirve para leer y para citar la idea, NO para una cita
 *     textual con número de página, porque las páginas no son las mismas.
 *   · `submittedVersion` — un preprint, sin revisión por pares todavía. Puede
 *     decir cosas que el artículo publicado ya no dice.
 *
 * Por eso se devuelve cuál es y la vista lo avisa. Un tesista que cite el
 * preprint creyendo que es el publicado tiene un problema que el asesor ve.
 *
 * Devuelve un `Map` de DOI en minúsculas donde el valor es
 * `{ url, esPdf, version, licencia, donde }` si hay copia abierta y `null` si
 * OpenAlex conoce la obra y no la hay. Los que OpenAlex NO CONOCE no están en
 * el `Map`, y esa diferencia es deliberada: es lo único que permite a quien
 * llama preguntarle a Unpaywall solo por esos —lo recién depositado, que es
 * donde los dos catálogos discrepan— en vez de por todos. Con `has()` se sabe
 * si OpenAlex contestó; con el valor, qué contestó.
 */
async function enlacesAbiertosPorDoi(dois) {
  const limpios = [...new Set(dois.map(limpiarDoi).filter(Boolean))];
  const enlaces = new Map();

  for (const lote of enLotes(limpios, POR_FILTRO)) {
    const resultados = await consultar({
      filter: `doi:${lote.join('|')}`,
      select: 'doi,open_access,best_oa_location',
      'per-page': String(POR_FILTRO),
    });
    for (const w of resultados) {
      const doi = limpiarDoi(w.doi);
      // Se anota aunque no haya enlace: que OpenAlex conozca la obra y no le
      // vea copia abierta YA ES su respuesta, y no hay que volver a preguntar.
      if (doi) enlaces.set(doi.toLowerCase(), comoEnlaceAbierto(w));
    }
  }

  return enlaces;
}

/**
 * La mejor copia abierta de una obra, o nulo si no hay ninguna.
 *
 * El orden de preferencia no es capricho. El `pdf_url` es el archivo, que es
 * lo que el tesista quiere; el `landing_page_url` es la página del repositorio
 * que lo contiene, un clic más pero se llega igual; y el `oa_url` de
 * `open_access` es el último recurso, que a veces trae algo cuando
 * `best_oa_location` viene vacío.
 */
function comoEnlaceAbierto(w) {
  const mejor = w.best_oa_location ?? null;
  const url = mejor?.pdf_url || mejor?.landing_page_url || w.open_access?.oa_url || null;
  if (!url) return null;

  return {
    url,
    /** Si al otro lado está el PDF o la página desde la que se descarga. */
    esPdf: Boolean(mejor?.pdf_url) && url === mejor.pdf_url,
    /** `publishedVersion` | `acceptedVersion` | `submittedVersion` | null. */
    version: mejor?.version ?? null,
    licencia: mejor?.license ?? null,
    /** El repositorio o la revista que la aloja, para decir de dónde sale. */
    donde: mejor?.source?.display_name ?? null,
  };
}

/**
 * Cuántas obras hay en cada valor de un campo, para un filtro.
 *
 * El `group_by` de OpenAlex: da los valores con más obras y su número, en una
 * sola consulta. Lo usan los números aproximados de los filtros del buscador
 * de Scopus, que Scopus no nos da. Devuelve `{ total, grupos }`, o nulo si
 * OpenAlex no contesta: sin números no se rompe nada, solo no se enseñan.
 */
async function agrupar(filtro, grupo, cuantos = 8) {
  const url = new URL(BASE);
  url.searchParams.set('filter', filtro);
  url.searchParams.set('group_by', grupo);
  url.searchParams.set('per_page', String(cuantos));
  firmar(url);

  const res = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS) }).catch(() => null);
  if (!res || !res.ok) {
    if (res) avisarRechazo(res, { grupo }, 'OpenAlex rechazó la consulta agrupada');
    return null;
  }

  const datos = await res.json().catch(() => null);
  if (!datos) return null;
  return {
    total: datos.meta?.count ?? 0,
    grupos: (datos.group_by ?? []).slice(0, cuantos).map((g) => ({
      clave: String(g.key ?? ''),
      nombre: String(g.key_display_name ?? ''),
      obras: Number(g.count) || 0,
    })),
  };
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

/** Lo más que se trae para un mapa. Cinco páginas de doscientas. */
const TOPE_DEL_MAPA = 1000;

/**
 * Por debajo de esta puntuación, la palabra clave es un «quizá» del
 * clasificador. Comprobado el 19-sep-2026 con «digital marketing small
 * business»: lo de 0,4 para arriba es del tema (Digital marketing 0,64, Small
 * business 0,56); lo de abajo es la disciplina de fondo (Computer science 0,14,
 * Sociology 0,10) y salía en casi todos los artículos, en el centro del mapa.
 */
const PUNTUACION_MINIMA = 0.4;

/**
 * Las diecinueve disciplinas raíz de OpenAlex (el nivel 0 de sus conceptos).
 * Con la puntuación que tengan, son el campo entero y no un tema: en un mapa de
 * marketing, «Business» sale en el 92 % de los artículos y tapa todo lo demás.
 */
const DISCIPLINAS_RAIZ = new Set(
  [
    'Art', 'Biology', 'Business', 'Chemistry', 'Computer science', 'Economics', 'Engineering',
    'Environmental science', 'Geography', 'Geology', 'History', 'Materials science', 'Mathematics',
    'Medicine', 'Philosophy', 'Physics', 'Political science', 'Psychology', 'Sociology',
  ].map((d) => d.toLowerCase()),
);

/**
 * Una palabra clave de OpenAlex, lista para el mapa, o null si no sirve.
 *
 * El clasificador desambigua mal a menudo y lo dice entre paréntesis:
 * «Resilience (materials science)» en un artículo de empresas, «Promotion
 * (chess)» en uno de marketing. La palabra sí es del artículo; el paréntesis
 * no. Se quita y queda «Resilience», que es lo que diría su autor.
 */
function palabraDelMapa(k) {
  if (!k?.display_name || (k.score ?? 0) < PUNTUACION_MINIMA) return null;
  if (DISCIPLINAS_RAIZ.has(k.display_name.toLowerCase())) return null;
  return k.display_name.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
}

/**
 * Qué campos de OpenAlex hacen falta para cada parte del mapa.
 *
 * Se piden solo los que usa el análisis: las referencias de mil obras son
 * cuarenta mil identificadores, y los resúmenes, megas de texto. Un mapa de
 * coautoría no necesita ninguna de las dos cosas.
 */
const CAMPOS_DEL_MAPA = {
  palabras: 'keywords',
  autores: 'authorships',
  fuente: 'primary_location',
  referencias: 'referenced_works',
  texto: 'abstract_inverted_index',
};

function seleccion(campos) {
  const base = ['id', 'doi', 'title', 'publication_year', 'cited_by_count'];
  return [...base, ...campos.map((c) => CAMPOS_DEL_MAPA[c]).filter(Boolean)].join(',');
}

const unicos = (lista) => [...new Set(lista.filter(Boolean))];

/**
 * Una obra de OpenAlex, en la forma que usan los mapas.
 *
 * Lo que no se pidió llega vacío, no ausente: así cada análisis lee siempre
 * los mismos campos sin preguntar si están.
 */
function obraDelMapa(w) {
  const autorias = w.authorships ?? [];
  return {
    id: soloElId(w.id),
    doi: limpiarDoi(w.doi),
    titulo: w.title ?? '',
    anio: w.publication_year ?? null,
    citas: w.cited_by_count ?? 0,
    palabras: (w.keywords ?? []).map(palabraDelMapa).filter(Boolean),
    autores: unicos(autorias.map((a) => nombreApa(a?.author?.display_name, a?.countries))),
    nAutores: autorias.length,
    instituciones: unicos(autorias.flatMap((a) => (a?.institutions ?? []).map((i) => i?.display_name))),
    paises: unicos(autorias.flatMap((a) => a?.countries ?? [])),
    fuente: w.primary_location?.source?.display_name ?? null,
    referencias: (w.referenced_works ?? []).map(soloElId),
    resumen: w.abstract_inverted_index ? resumenDelIndice(w.abstract_inverted_index) : null,
  };
}

/**
 * Las obras de un tema, para un mapa.
 *
 * Doscientas por página —el máximo de OpenAlex— y por cursor, que es la única
 * paginación que no se degrada pasadas las primeras. Las más citadas primero:
 * con un tope de mil, son las que definen el campo.
 *
 * Busca en título y resumen, no en el texto completo: para un mapa del campo
 * sobran los artículos que solo mencionan el tema de pasada, y son los que más
 * ensucian el mapa con palabras que no son del tema.
 *
 * Devuelve `{ obras, total, caida }`. `caida` solo si la PRIMERA página no
 * llegó; si falla una posterior, se hace el mapa con lo que ya hay.
 */
async function obrasParaMapa({
  tema,
  desdeAnio = null,
  hastaAnio = null,
  idioma = null,
  cuantas = 500,
  campos = ['palabras'],
}) {
  const quiero = Math.min(Math.max(cuantas, 1), TOPE_DEL_MAPA);
  const filtros = [`title_and_abstract.search:${tema.replace(/,/g, ' ')}`];
  if (desdeAnio) filtros.push(`from_publication_date:${desdeAnio}-01-01`);
  if (hastaAnio) filtros.push(`to_publication_date:${hastaAnio}-12-31`);
  if (idioma) filtros.push(`language:${idioma}`);

  const obras = [];
  let total = 0;
  let cursor = '*';

  while (cursor && obras.length < quiero) {
    const url = new URL(BASE);
    url.searchParams.set('filter', filtros.join(','));
    url.searchParams.set('select', seleccion(campos));
    url.searchParams.set('sort', 'cited_by_count:desc');
    url.searchParams.set('per_page', String(Math.min(200, quiero - obras.length)));
    url.searchParams.set('cursor', cursor);
    firmar(url);

    // Con referencias y resúmenes una página pesa más: se le da el doble.
    const res = await fetch(url, { signal: AbortSignal.timeout(TIEMPO_LIMITE_MS * 2) }).catch((error) => {
      logger.warn({ err: error, tema }, 'OpenAlex no respondió al pedir obras para un mapa');
      return null;
    });

    if (!res || !res.ok) {
      if (res) avisarRechazo(res, { tema }, 'OpenAlex rechazó las obras para un mapa');
      if (obras.length === 0) return { obras: [], total: 0, caida: true };
      break;
    }

    const datos = await res.json().catch(() => null);
    const pagina = datos?.results ?? [];
    total = datos?.meta?.count ?? total;
    for (const w of pagina) obras.push(obraDelMapa(w));

    cursor = pagina.length > 0 ? datos?.meta?.next_cursor ?? null : null;
  }

  return { obras, total, caida: false };
}

/**
 * Las obras de una lista de DOI o de identificadores, para un mapa.
 *
 * Es lo que deja hacer con SUS fuentes los mismos análisis que con una
 * búsqueda: su export de Scopus trae el DOI, y los autores con su afiliación,
 * la revista y las referencias llegan de aquí. En lotes de cincuenta, una
 * petición por lote.
 */
async function obrasPorLotes(campo, valores, campos) {
  const obras = [];
  for (const lote of enLotes(unicos(valores), POR_FILTRO)) {
    const resultados = await consultar({
      filter: `${campo}:${lote.join('|')}`,
      select: seleccion(campos),
      'per-page': String(POR_FILTRO),
    });
    for (const w of resultados) obras.push(obraDelMapa(w));
  }
  return obras;
}

const obrasPorDoi = (dois, campos) => obrasPorLotes('doi', dois.map(limpiarDoi).filter(Boolean), campos);
const obrasPorIds = (ids, campos) => obrasPorLotes('ids.openalex', ids.map(soloElId), campos);

/** «https://openalex.org/W123» → «W123». El filtro quiere el corto. */
const soloElId = (id) => String(id).replace(/^https?:\/\/openalex\.org\//i, '');

module.exports = {
  buscar,
  porDoi,
  referenciasDe,
  porIds,
  resumenesPorDoi,
  enlacesAbiertosPorDoi,
  agrupar,
  citanA,
  obrasParaMapa,
  obrasPorDoi,
  obrasPorIds,
  limpiarDoi,
  nombreApa,
  resumenDelIndice,
  soloElId,
};
