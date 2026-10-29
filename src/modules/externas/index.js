'use strict';

/**
 * Las bases externas del buscador del panel, además de Scopus, SciELO y el
 * resto de OpenAlex. Cada una se elige en el menú «Ver» de la web y se busca
 * sola, 25 por página. Ver `documentacion/05-integraciones.md`.
 *
 * EL CONTRATO DE CADA BASE (un archivo por base en esta carpeta)
 * ---------------------------------------------------------------
 *   clave:   'pubmed'            identificador corto, minúsculas, sin espacios
 *   nombre:  'PubMed'            como se ve en la web
 *   detalle: 'Salud y medicina'  una línea para el menú
 *   activa(): boolean            false si le falta una clave que exige
 *
 *   async buscar({ consulta, palabras, pagina, porPagina, desde, hasta })
 *     consulta: '("a" OR "b") AND ("c")'  booleana, de `busquedaDeConceptos`
 *     palabras: 'a b c'                    lo mismo en palabras sueltas, para
 *                                          las bases que no entienden AND/OR
 *     desde/hasta: años o null
 *     → { resultados: [Resultado], total: number, caida: boolean }
 *     Nunca lanza: si la base falla, `comun.CAIDA`.
 *
 *   async porIds(ids) → [Ficha]   ids SIN el prefijo de la base
 *     Para guardar lo marcado: la ficha se vuelve a pedir aquí y no se cree lo
 *     que mande el navegador. Lo que ya no exista, simplemente no vuelve.
 *
 * Resultado (la misma forma que la lista de SciELO, ver `openalex.buscarEnScielo`):
 *   { id, doi, titulo, autores, anio, revista, idioma, citas, enlace, pdfLibre, resumen, tipo }
 *   id: el de la base, sin prefijo. autores: `comun.autoresApa`. citas: número o 0.
 *   tipo: 'article' | 'review' | 'dissertation' | 'preprint' | 'book' | 'chapter' | 'other'
 *
 * Ficha (lo que entra a `propias.service.comoFila`):
 *   { id, doi, title, authors, year, source, volume, issue, pages, url, abstract, itemType }
 *   itemType: 'journalArticle' | 'thesis' | 'book' | 'bookSection' | 'preprint' | 'document'
 */

const BASES = [
  require('./latinoamerica'),
  require('./semanticscholar'),
  require('./core'),
  require('./pubmed'),
  require('./europepmc'),
  require('./eric'),
  require('./doaj'),
  require('./crossref'),
  require('./arxiv'),
  require('./dblp'),
  require('./zenodo'),
  require('./hal'),
  require('./openaire'),
];

const porClave = new Map(BASES.map((b) => [b.clave, b]));

/** La base por su clave, o null. */
function base(clave) {
  return porClave.get(String(clave ?? '')) ?? null;
}

/** Lo que la web necesita para el menú «Ver». */
function lista() {
  return BASES.map((b) => ({ clave: b.clave, nombre: b.nombre, detalle: b.detalle, activa: b.activa() }));
}

module.exports = { BASES, base, lista };
