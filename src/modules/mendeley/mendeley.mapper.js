'use strict';

const { normalizar } = require('../references/zotero.mapper');

/**
 * Traduce un documento de Mendeley a una fila de `references`.
 *
 * El tipo se traduce A LOS NOMBRES DE ZOTERO (`journal` → `journalArticle`).
 * No es por gusto: el Word, el BibTeX y el CSL ya saben leer esos nombres
 * (ver `project.csl.tipoCsl`), y un `book_section` de Mendeley sin traducir se
 * leería como libro —contiene «book»— en vez de como capítulo.
 */
const TIPOS = {
  journal: 'journalArticle',
  book: 'book',
  book_section: 'bookSection',
  conference_proceedings: 'conferencePaper',
  thesis: 'thesis',
  report: 'report',
  working_paper: 'report',
  web_page: 'webpage',
  magazine_article: 'magazineArticle',
  newspaper_article: 'newspaperArticle',
  encyclopedia_article: 'encyclopediaArticle',
  computer_program: 'computerProgram',
  patent: 'patent',
  statute: 'statute',
  case: 'case',
  bill: 'bill',
  hearing: 'hearing',
  film: 'film',
  television_broadcast: 'tvBroadcast',
  generic: 'document',
};

const recortar = (valor, largo) => (valor ? String(valor).slice(0, largo) : null);

/** «Hernández, R.; Fernández, C.». Los editores solo si no hay ningún autor. */
function autores(documento) {
  const lista =
    Array.isArray(documento.authors) && documento.authors.length > 0
      ? documento.authors
      : Array.isArray(documento.editors)
        ? documento.editors
        : [];

  return lista
    .slice(0, 8)
    .map((persona) => {
      const apellido = String(persona.last_name ?? '').trim();
      const nombre = String(persona.first_name ?? '').trim();
      // Sin nombre de pila es una institución: va entera, sin inicial.
      if (!nombre) return apellido;
      return [apellido, `${nombre.charAt(0)}.`].filter(Boolean).join(', ');
    })
    .filter(Boolean)
    .join('; ');
}

/** Dónde se publicó: la revista o el libro; si no, quien lo publica. */
function fuente(documento) {
  return documento.source || documento.institution || documento.publisher || null;
}

function doi(documento) {
  const crudo = documento.identifiers?.doi;
  return crudo ? String(crudo).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null;
}

function anio(documento) {
  const numero = Number(documento.year);
  return Number.isInteger(numero) && numero >= 1500 && numero <= 2100 ? numero : null;
}

/** Un documento sin id o sin título no es una fuente que se pueda citar. */
const esFuente = (documento) => Boolean(documento?.id && String(documento.title ?? '').trim());

/**
 * La fila, sin dueño ni identidad: eso lo pone el servicio, que sabe de quién
 * es y con qué prefijo.
 *
 * Las etiquetas del tesista y las palabras clave del autor van juntas en
 * `tags`: las dos sirven para encontrar la fuente, y separarlas no le dice
 * nada a quien busca.
 */
function aFila(documento) {
  const etiquetas = [
    ...new Set([...(documento.tags ?? []), ...(documento.keywords ?? [])].map((t) => String(t).trim()).filter(Boolean)),
  ];
  const resumen = String(documento.abstract ?? '').trim();

  const fila = {
    zoteroKey: null,
    version: 0,
    itemType: TIPOS[documento.type] ?? 'document',
    title: recortar(String(documento.title).trim(), 500),
    authors: recortar(autores(documento), 500) ?? '',
    year: anio(documento),
    source: recortar(fuente(documento), 300),
    volume: recortar(documento.volume, 40),
    issue: recortar(documento.issue, 40),
    pages: recortar(documento.pages, 40),
    doi: recortar(doi(documento), 200),
    url: recortar(Array.isArray(documento.websites) ? documento.websites[0] : null, 500),
    abstract: resumen || null,
    notes: null,
    tags: recortar(etiquetas.join(', '), 500) ?? '',
    origin: 'MENDELEY',
  };

  fila.busqueda = normalizar(
    [fila.title, fila.authors, fila.source, fila.year, resumen, etiquetas.join(' ')]
      .filter(Boolean)
      .join(' '),
  );

  return fila;
}

module.exports = { aFila, esFuente, TIPOS };
