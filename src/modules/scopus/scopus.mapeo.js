'use strict';

/**
 * «Hacer un mapeo bibliométrico con estos resultados»: de una búsqueda de
 * Scopus en la web a la sesión de R del tesista, lista para bibliometrix.
 *
 * DE SCOPUS, SOLO LOS DOI
 * -----------------------
 * La vista STANDARD de la API no trae referencias, ni palabras clave, ni todos
 * los autores, ni sus afiliaciones: justo lo que necesita un mapeo. Y los datos
 * de Scopus no se guardan ni se reparten (mismo criterio que el mapa de
 * VOSviewer). Así que de Scopus se toma la lista de DOI de la búsqueda y lo
 * demás llega de OpenAlex, que es abierto: autores con su institución y su
 * país, palabras clave, resumen y referencias citadas.
 *
 * EL FORMATO
 * ----------
 * El CSV que exportaba OpenAlex, con los nombres de columna de su API y los
 * valores múltiples separados por «|». Es el que bibliometrix lee con
 * `dbsource = "openalex"`, y el que traduce solo los códigos de país a nombres.
 * Los autores, sus instituciones, sus países y la marca de correspondencia van
 * alineados —uno por autor— porque bibliometrix los empareja por posición.
 */

const logger = require('../../config/logger');
const { ValidationError, AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const cliente = require('./scopus.client');
const openalex = require('../references/openalex.client');

/**
 * Cuántos documentos como mucho: medido en la jaula de R el 21-sep-2026, dos
 * mil caben en memoria y cada análisis en su tiempo. Los más citados primero.
 */
const TOPE_DEL_MAPEO = 2000;

/**
 * Páginas de Scopus que se piden a la vez. De veinticinco en veinticinco —con
 * nuestra clave, Elsevier rechaza más por página: «Exceeds the maximum number
 * allowed for the service level», probado el 21-sep-2026—, dos mil son ochenta
 * páginas; de cinco en cinco, dieciséis rondas.
 */
const PAGINAS_A_LA_VEZ = 5;

const COLUMNAS = [
  'id',
  'doi',
  'display_name',
  'publication_year',
  'type',
  'language',
  'cited_by_count',
  'primary_location.source.display_name',
  'primary_location.source.id',
  'authorships.author.display_name',
  'authorships.author.id',
  'authorships.countries',
  'authorships.institutions.display_name',
  'authorships.institutions.id',
  'authorships.is_corresponding',
  'keywords.display_name',
  'referenced_works',
  'referenced_works_count',
  'abstract',
];

/** Una celda: sin «|» ni saltos dentro, que partirían el valor o la fila. */
function limpio(valor) {
  return String(valor ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .trim();
}

const juntar = (lista) => lista.map(limpio).join('|');

/** Una obra de OpenAlex, como fila del CSV. */
function filaDe(w, etiquetas = new Map()) {
  const autorias = w.authorships ?? [];
  const primera = (a) => a?.institutions?.[0] ?? null;

  return {
    id: w.id,
    doi: w.doi ?? '',
    display_name: limpio(w.display_name ?? w.title),
    publication_year: w.publication_year ?? '',
    type: w.type ?? '',
    language: w.language ?? '',
    cited_by_count: w.cited_by_count ?? 0,
    'primary_location.source.display_name': limpio(w.primary_location?.source?.display_name),
    'primary_location.source.id': w.primary_location?.source?.id ?? '',
    'authorships.author.display_name': juntar(autorias.map((a) => a?.author?.display_name)),
    'authorships.author.id': juntar(autorias.map((a) => a?.author?.id)),
    // Uno por autor, el primero, para que vaya alineado con su nombre.
    'authorships.countries': juntar(autorias.map((a) => a?.countries?.[0] ?? primera(a)?.country_code)),
    'authorships.institutions.display_name': juntar(autorias.map((a) => primera(a)?.display_name)),
    'authorships.institutions.id': juntar(autorias.map((a) => primera(a)?.id)),
    'authorships.is_corresponding': juntar(autorias.map((a) => (a?.is_corresponding ? 'true' : 'false'))),
    'keywords.display_name': juntar((w.keywords ?? []).map((k) => k?.display_name).filter(Boolean)),
    referenced_works: juntar((w.referenced_works ?? []).map((r) => etiquetas.get(r) ?? r)),
    referenced_works_count: w.referenced_works_count ?? (w.referenced_works ?? []).length,
    abstract: limpio(openalex.resumenDelIndice(w.abstract_inverted_index)),
  };
}

function campoCsv(valor) {
  return `"${String(valor ?? '').replace(/"/g, '""')}"`;
}

/** Las obras, como el CSV de OpenAlex que lee bibliometrix. */
function csvDeOpenAlex(obras, etiquetas = new Map()) {
  const lineas = [COLUMNAS.map(campoCsv).join(',')];
  for (const w of obras) {
    const fila = filaDe(w, etiquetas);
    lineas.push(COLUMNAS.map((c) => campoCsv(fila[c])).join(','));
  }
  return `${lineas.join('\n')}\n`;
}

/** Cuántas referencias, las más citadas del corpus, llevan nombre en vez de identificador. */
const REFERENCIAS_CON_NOMBRE = 200;

/**
 * Las referencias más citadas del corpus, con «Autor, I. (año)» en vez de
 * «W2146887469».
 *
 * OpenAlex da las referencias como identificadores, y así salen en la red de
 * cocitación: un tesista no puede leer «w2146887469». Las que se dibujan son
 * siempre de las más citadas, así que basta con nombrar esas: cuatro
 * peticiones más. Lo que no se encuentre sigue con su identificador.
 *
 * Sin «;» ni «|» en la etiqueta: bibliometrix parte las referencias por ahí.
 */
async function etiquetasDeReferencias(obras) {
  const veces = new Map();
  for (const w of obras) {
    for (const r of w.referenced_works ?? []) veces.set(r, (veces.get(r) ?? 0) + 1);
  }
  const top = [...veces.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, REFERENCIAS_CON_NOMBRE)
    .map(([id]) => id);
  if (top.length === 0) return new Map();

  const etiquetas = new Map();
  const usadas = new Set();
  try {
    for (const obra of await openalex.obrasPorIds(top, ['autores'])) {
      const autor = obra.autores[0] ?? 'Anónimo';
      let etiqueta = `${autor} (${obra.anio ?? 's. f.'})`.replace(/[;|]/g, ',');
      // Dos del mismo autor y año: se distinguen por el principio del título.
      if (usadas.has(etiqueta)) etiqueta = `${etiqueta} ${limpio(obra.titulo).slice(0, 30)}`.replace(/[;|]/g, ',');
      usadas.add(etiqueta);
      etiquetas.set(`https://openalex.org/${obra.id}`, etiqueta);
    }
  } catch (error) {
    logger.warn({ err: error }, 'Mapeo desde Scopus: no se pudieron nombrar las referencias');
  }
  return etiquetas;
}

/**
 * Los DOI de una búsqueda de Scopus, de los más citados a los menos, hasta el
 * tope. Devuelve también cuántos resultados tiene la búsqueda y cuántos de los
 * recorridos no traen DOI.
 */
async function doisDeLaBusqueda({ ecuacion, accessToken }) {
  const porPagina = cliente.POR_PAGINA;
  const pedir = (desde) =>
    cliente.buscar({ ecuacion, desde, cuantas: porPagina, orden: 'citas', accessToken });

  // La primera dice cuántos hay; el resto se pide por tandas, en orden.
  const primera = await pedir(0);
  const total = primera.total;
  const hasta = Math.min(total, TOPE_DEL_MAPEO);
  const paginas = [primera];

  const desdes = [];
  for (let desde = porPagina; desde < hasta; desde += porPagina) desdes.push(desde);
  for (let i = 0; i < desdes.length; i += PAGINAS_A_LA_VEZ) {
    paginas.push(...(await Promise.all(desdes.slice(i, i + PAGINAS_A_LA_VEZ).map(pedir))));
  }

  const fichas = paginas.flatMap((p) => p.fichas).slice(0, TOPE_DEL_MAPEO);
  const dois = fichas.map((f) => openalex.limpiarDoi(f['prism:doi'])).filter(Boolean);
  return { dois: [...new Set(dois)], total, recorridos: fichas.length };
}

/**
 * Todo el camino: la búsqueda, OpenAlex, el CSV y la sesión de R.
 *
 * `subir` es la subida de la sesión de R (`r.service.subirDatos`), que se pasa
 * de fuera para que este módulo no dependa del motor.
 */
async function prepararMapeo({ ecuacion, accessToken, subir }) {
  const texto = String(ecuacion ?? '').trim();
  if (!texto) throw new ValidationError('Falta la búsqueda que quieres mapear.');

  const { dois, total, recorridos } = await doisDeLaBusqueda({ ecuacion: texto, accessToken });
  if (total === 0) throw new ValidationError('Esa búsqueda no tiene resultados en Scopus.');
  if (dois.length === 0) {
    throw new ValidationError('Ninguno de los resultados trae DOI, y sin DOI no se pueden completar sus datos.');
  }

  const obras = await openalex.obrasCompletasPorDoi(dois);
  if (obras.length === 0) {
    logger.warn({ dois: dois.length }, 'Mapeo desde Scopus: OpenAlex no devolvió ninguna obra');
    throw new AppError('El catálogo abierto no respondió. Inténtalo en unos minutos.', {
      statusCode: 503,
      code: ERROR_CODES.EXTERNAL_UNAVAILABLE,
    });
  }

  const etiquetas = await etiquetasDeReferencias(obras);
  const subido = await subir(Buffer.from(csvDeOpenAlex(obras, etiquetas), 'utf8'));

  return {
    total,
    recorridos,
    conDoi: dois.length,
    documentos: obras.length,
    sinDatos: dois.length - obras.length,
    tope: TOPE_DEL_MAPEO,
    leido: subido.leido,
    detalle: subido.detalle ?? null,
  };
}

module.exports = {
  prepararMapeo,
  csvDeOpenAlex,
  filaDe,
  doisDeLaBusqueda,
  etiquetasDeReferencias,
  TOPE_DEL_MAPEO,
  COLUMNAS,
};
