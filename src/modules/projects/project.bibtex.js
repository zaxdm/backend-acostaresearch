'use strict';

/**
 * La bibliografía en BibTeX, para quien escribe en LaTeX.
 *
 * LA CLAVE YA ESTABA
 * ------------------
 * El asistente escribe `[AR97D22F86]` en el texto y el Word lo cambia por
 * «(Venero Gibaja et al., 2024)». Esa misma clave es el citekey del BibTeX, así
 * que quien use LaTeX no tiene que inventarse nada ni casar dos listas: lo que
 * está entre corchetes en su capítulo es exactamente lo que va dentro de
 * `\cite{}`. Pasar de uno a otro es un buscar-y-reemplazar de corchetes.
 *
 * Es una propiedad que salió gratis de haber puesto claves estables en las
 * fuentes, y es la razón por la que este archivo son cien líneas y no un
 * proyecto.
 *
 * QUÉ NO HACE
 * -----------
 * No genera el `.tex`. Da la bibliografía, que es la parte que no se puede
 * escribir a mano sin equivocarse; el documento lo monta el tesista con la
 * plantilla que le exija su facultad, que son todas distintas.
 */

/**
 * Caracteres que en LaTeX significan otra cosa.
 *
 * Sin esto, un título con «Salud & Bienestar» rompe la compilación, y uno con
 * un guion bajo saca un subíndice donde no lo hay. Falla al compilar, que es
 * mejor que fallar en silencio, pero le arruina la tarde a alguien que no sabe
 * LaTeX lo suficiente para entender el error.
 */
const ESCAPES = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/**
 * UNA SOLA PASADA, y esto no es una optimización.
 *
 * En dos pasadas —primero la barra invertida, luego el resto— la segunda vuelve
 * a mirar lo que escribió la primera: `\textbackslash{}` lleva llaves, y salen
 * escapadas otra vez como `\textbackslash\{\}`. En el orden contrario pasa lo
 * mismo con las barras. Cualquier reparto en dos pasos se muerde la cola.
 *
 * Con una sola expresión, cada carácter del original se sustituye exactamente
 * una vez y lo que sale de la sustitución ya no se vuelve a leer.
 */
function escapar(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/[\\{}$&%#_~^]/g, (c) => ESCAPES[c])
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * De qué tipo es la entrada.
 *
 * Los tipos llegan de dos sitios y escritos distinto: Zotero usa `journalArticle`
 * y el export de Scopus, «Conference Paper». Se normaliza y se compara sin
 * espacios, que es lo único que aguanta las dos convenciones sin una tabla por
 * cada una.
 */
const TIPOS = {
  journalarticle: 'article',
  article: 'article',
  articleinpress: 'article',
  review: 'article',
  conferencepaper: 'inproceedings',
  conferenceproceeding: 'inproceedings',
  inproceedings: 'inproceedings',
  book: 'book',
  booksection: 'incollection',
  bookchapter: 'incollection',
  chapter: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  preprint: 'misc',
  webpage: 'misc',
};

function tipoDeEntrada(itemType) {
  const clave = String(itemType ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  // `misc` como red: una entrada de tipo desconocido compila igual, y perder el
  // tipo exacto es mucho menos grave que perder la fuente.
  return TIPOS[clave] ?? 'misc';
}

/**
 * Dónde se publicó, con el nombre de campo que espera cada tipo.
 *
 * Es el mismo dato —la columna `source`— pero BibTeX lo llama distinto según la
 * entrada, y ponerlo en el campo equivocado hace que el estilo no lo imprima:
 * la fuente sale en la bibliografía sin revista, que es como no salir.
 */
function campoDeLaFuente(tipo) {
  if (tipo === 'article') return 'journal';
  if (tipo === 'inproceedings' || tipo === 'incollection') return 'booktitle';
  if (tipo === 'book' || tipo === 'techreport') return 'publisher';
  if (tipo === 'phdthesis') return 'school';
  return 'howpublished';
}

/** «Apellido, N.; Apellido, N.» → «Apellido, N. and Apellido, N.» */
function autores(valor) {
  if (!valor) return null;
  return String(valor)
    .split(/\s*;\s*/)
    .map((persona) => escapar(persona))
    .filter(Boolean)
    .join(' and ');
}

/**
 * Una entrada.
 *
 * El título va entre DOS llaves. La de fuera la pone el campo y la de dentro
 * protege las mayúsculas: sin ella, los estilos que normalizan la capitalización
 * convierten «Validity in Latin America» en «Validity in latin america», y un
 * nombre propio en minúscula en la bibliografía es de las cosas que un jurado sí
 * mira.
 */
function entrada(fuente) {
  const tipo = tipoDeEntrada(fuente.itemType);
  const campos = [];

  const añadir = (nombre, valor) => {
    if (valor === null || valor === undefined || valor === '') return;
    campos.push(`  ${nombre} = {${valor}}`);
  };

  añadir('author', autores(fuente.authors));
  añadir('title', `{${escapar(fuente.title)}}`);
  if (fuente.year) añadir('year', String(fuente.year));
  añadir(campoDeLaFuente(tipo), escapar(fuente.source));
  // En BibTeX el número de la revista se llama 'number', no 'issue', y las
  // páginas van con doble guion: BibTeX lo compone como el guion largo que
  // pide la tipografía de un rango.
  añadir('volume', escapar(fuente.volume));
  añadir('number', escapar(fuente.issue));
  añadir('pages', escapar(String(fuente.pages ?? '').replace(/-+/, '--')));
  añadir('doi', escapar(fuente.doi));
  // Sin DOI se da la URL. Con DOI no: el DOI ya es la dirección estable y las
  // dos juntas hacen que casi todos los estilos impriman el enlace dos veces.
  if (!fuente.doi) añadir('url', escapar(fuente.url));
  añadir('abstract', escapar(fuente.abstract));
  añadir('keywords', escapar(fuente.tags));

  return `@${tipo}{${fuente.ref},\n${campos.join(',\n')}\n}`;
}

/**
 * El archivo entero.
 *
 * Ordenado por clave y no alfabético por autor: en un `.bib` el orden no se ve
 * —lo decide el estilo al imprimir la bibliografía— y por clave es estable, así
 * que dos descargas seguidas dan archivos idénticos y el control de versiones
 * del tesista no se llena de cambios que no son cambios.
 */
function armar(fuentes) {
  const cabecera = [
    '% Bibliografía generada por Acosta | IA & Research',
    `% ${fuentes.length} fuentes · ${new Date().toISOString().slice(0, 10)}`,
    '%',
    '% Las claves son las mismas que aparecen entre corchetes en tus capítulos,',
    '% así que [AR97D22F86] en el texto es \\cite{AR97D22F86} en LaTeX.',
    '%',
    '% El archivo está en UTF-8. Compila con biber, o con bibtex si añades',
    '% \\usepackage[utf8]{inputenc}.',
    '',
  ].join('\n');

  const entradas = [...fuentes]
    .sort((a, b) => String(a.ref).localeCompare(String(b.ref)))
    .map(entrada);

  return `${cabecera}\n${entradas.join('\n\n')}\n`;
}

module.exports = { armar, entrada, tipoDeEntrada, escapar, autores };
