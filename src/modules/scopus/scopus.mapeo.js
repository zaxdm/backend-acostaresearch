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

const env = require('../../config/env');
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

/** Por página en la vista STANDARD: el máximo que admite la API. */
const POR_PAGINA_STANDARD = 200;

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
function filaDe(w) {
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
    referenced_works: juntar(w.referenced_works ?? []),
    referenced_works_count: w.referenced_works_count ?? (w.referenced_works ?? []).length,
    abstract: limpio(openalex.resumenDelIndice(w.abstract_inverted_index)),
  };
}

function campoCsv(valor) {
  return `"${String(valor ?? '').replace(/"/g, '""')}"`;
}

/** Las obras, como el CSV de OpenAlex que lee bibliometrix. */
function csvDeOpenAlex(obras) {
  const lineas = [COLUMNAS.map(campoCsv).join(',')];
  for (const w of obras) {
    const fila = filaDe(w);
    lineas.push(COLUMNAS.map((c) => campoCsv(fila[c])).join(','));
  }
  return `${lineas.join('\n')}\n`;
}

/**
 * Los DOI de una búsqueda de Scopus, de los más citados a los menos, hasta el
 * tope. Devuelve también cuántos resultados tiene la búsqueda y cuántos de los
 * recorridos no traen DOI.
 */
async function doisDeLaBusqueda({ ecuacion, accessToken }) {
  const porPagina = env.scopusView === 'COMPLETE' ? cliente.POR_PAGINA : POR_PAGINA_STANDARD;
  const dois = [];
  let total = 0;
  let recorridos = 0;

  for (let desde = 0; desde < TOPE_DEL_MAPEO; desde += porPagina) {
    const pagina = await cliente.buscar({
      ecuacion,
      desde,
      cuantas: Math.min(porPagina, TOPE_DEL_MAPEO - desde),
      orden: 'citas',
      accessToken,
      porPaginaMaxima: porPagina,
    });
    total = pagina.total;
    recorridos += pagina.fichas.length;
    for (const ficha of pagina.fichas) {
      const doi = openalex.limpiarDoi(ficha['prism:doi']);
      if (doi) dois.push(doi);
    }
    if (pagina.fichas.length < porPagina || desde + porPagina >= total) break;
  }

  return { dois: [...new Set(dois)], total, recorridos };
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

  const subido = await subir(Buffer.from(csvDeOpenAlex(obras), 'utf8'));

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

module.exports = { prepararMapeo, csvDeOpenAlex, filaDe, doisDeLaBusqueda, TOPE_DEL_MAPEO, COLUMNAS };
