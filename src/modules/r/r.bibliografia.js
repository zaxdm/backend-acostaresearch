'use strict';

/**
 * El exporte de una base bibliográfica, para el mapeo bibliométrico con
 * bibliometrix.
 *
 * Es la otra cosa que se sube al mismo enlace que la matriz: en vez de una fila
 * por persona, una fila por documento. Se reconoce por el contenido —la
 * extensión la pone quien sube el archivo— y se lee con
 * `bibliometrix::convert2df`, que deja en `datos` la tabla con las etiquetas de
 * Web of Science (AU, TI, SO, PY, TC, CR, DE, ID, C1…) que esperan todas sus
 * funciones.
 *
 * EL TEXTO PLANO DE SCOPUS
 * ------------------------
 * Es lo que baja quien pulsa «Exportar» en Scopus sin cambiar nada, y
 * bibliometrix no lo lee: solo lee el CSV y el BibTeX de Scopus. Trae los mismos
 * campos, así que aquí se pasa a CSV con las columnas del exporte en CSV —las
 * que `csvScopus2df` reconoce— y el tesista no tiene que volver a exportar.
 */

const MUESTRA = 16384;

/** La base de la que viene, con el `dbsource` y el `format` de convert2df. */
const BASES = {
  'scopus-csv': { nombre: 'Scopus (CSV)', dbsource: 'scopus', format: 'csv', archivo: 'datos.csv' },
  'scopus-bibtex': { nombre: 'Scopus (BibTeX)', dbsource: 'scopus', format: 'bibtex', archivo: 'datos.bib' },
  'scopus-txt': { nombre: 'Scopus (texto plano)', dbsource: 'scopus', format: 'csv', archivo: 'datos.csv' },
  'wos-txt': { nombre: 'Web of Science (texto plano)', dbsource: 'wos', format: 'plaintext', archivo: 'datos.txt' },
  'wos-bibtex': { nombre: 'Web of Science (BibTeX)', dbsource: 'wos', format: 'bibtex', archivo: 'datos.bib' },
  pubmed: { nombre: 'PubMed (MEDLINE)', dbsource: 'pubmed', format: 'pubmed', archivo: 'datos.txt' },
  'lens-csv': { nombre: 'Lens.org (CSV)', dbsource: 'lens', format: 'csv', archivo: 'datos.csv' },
};

class BibliografiaNoValida extends Error {}

function sinBom(texto) {
  return texto.replace(/^﻿/, '');
}

/** La primera línea que no está vacía. */
function primeraLinea(texto) {
  return (texto.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
}

/**
 * De qué base viene el exporte, o null si no es un exporte bibliográfico.
 *
 * Solo mira el principio del archivo y busca marcas que una matriz de datos no
 * tiene nunca: la cabecera de columnas propia de Scopus o de Lens, las
 * etiquetas de dos letras de WoS y de PubMed, o el «@article{» de BibTeX.
 */
function detectar(bytes) {
  const muestra = bytes.subarray(0, MUESTRA);
  if (muestra.length === 0 || muestra.includes(0x00)) return null;

  const texto = sinBom(new TextDecoder('utf-8').decode(muestra));
  const cabecera = primeraLinea(texto);

  if (/^scopus$/i.test(cabecera) && /^EXPORT DATE:/m.test(texto)) {
    return /^\s*@[A-Za-z]+\s*\{/m.test(texto) ? 'scopus-bibtex' : 'scopus-txt';
  }
  if (/^FN (?:Clarivate|Thomson Reuters)/.test(cabecera) || (/^FN /.test(cabecera) && /^PT [A-Z]\s*$/m.test(texto))) {
    return 'wos-txt';
  }
  if (/^PMID- ?\d+/m.test(texto) && /^(?:TI|AU)\s{2}- /m.test(texto)) return 'pubmed';

  if (/^\s*@[A-Za-z]+\s*\{/m.test(texto)) {
    if (/Unique-ID\s*=\s*\{\s*WOS:/i.test(texto)) return 'wos-bibtex';
    if (/source\s*=\s*\{\s*Scopus\s*\}/i.test(texto)) return 'scopus-bibtex';
    return 'bibtex-otro';
  }

  const columnas = cabecera.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  if (columnas.includes('Source title') && (columnas.includes('EID') || columnas.includes('Link'))) {
    return 'scopus-csv';
  }
  if (columnas.includes('Lens ID')) return 'lens-csv';

  return null;
}

// ── Del texto plano de Scopus a su CSV ──────────────────────────────────────

/** Las etiquetas del texto plano y la columna del CSV que les corresponde. */
const COLUMNAS_DE_ETIQUETA = {
  'AUTHOR FULL NAMES': 'Author full names',
  'AUTHORS WITH AFFILIATIONS': 'Authors with affiliations',
  AFFILIATIONS: 'Affiliations',
  ABSTRACT: 'Abstract',
  'AUTHOR KEYWORDS': 'Author Keywords',
  'INDEX KEYWORDS': 'Index Keywords',
  'MOLECULAR SEQUENCE NUMBERS': 'Molecular Sequence Numbers',
  'CHEMICALS/CAS': 'Chemicals/CAS',
  TRADENAMES: 'Tradenames',
  MANUFACTURERS: 'Manufacturers',
  'FUNDING DETAILS': 'Funding Details',
  REFERENCES: 'References',
  'CORRESPONDENCE ADDRESS': 'Correspondence Address',
  EDITORS: 'Editors',
  PUBLISHER: 'Publisher',
  SPONSORS: 'Sponsors',
  'CONFERENCE NAME': 'Conference name',
  'CONFERENCE DATE': 'Conference date',
  'CONFERENCE LOCATION': 'Conference location',
  'CONFERENCE CODE': 'Conference code',
  ISSN: 'ISSN',
  ISBN: 'ISBN',
  CODEN: 'CODEN',
  'PUBMED ID': 'PubMed ID',
  'LANGUAGE OF ORIGINAL DOCUMENT': 'Language of Original Document',
  'ABBREVIATED SOURCE TITLE': 'Abbreviated Source Title',
  'DOCUMENT TYPE': 'Document Type',
  'PUBLICATION STAGE': 'Publication Stage',
  'OPEN ACCESS': 'Open Access',
  SOURCE: 'Source',
  DOI: 'DOI',
};

/** El orden del CSV de Scopus. Lo que no esté aquí va detrás. */
const ORDEN = [
  'Authors',
  'Author full names',
  'Author(s) ID',
  'Title',
  'Year',
  'Source title',
  'Volume',
  'Issue',
  'Art. No.',
  'Page start',
  'Page end',
  'Cited by',
  'DOI',
  'Link',
  'Affiliations',
  'Authors with affiliations',
  'Abstract',
  'Author Keywords',
  'Index Keywords',
  'Funding Details',
  'Funding Texts',
  'References',
  'Correspondence Address',
  'Editors',
  'Publisher',
  'ISSN',
  'ISBN',
  'PubMed ID',
  'Language of Original Document',
  'Abbreviated Source Title',
  'Document Type',
  'Publication Stage',
  'Open Access',
  'Source',
  'EID',
];

/** «TAG: valor» si TAG es una etiqueta conocida; una referencia que empieza por «UNESCO:» no lo es. */
function etiquetaDe(linea) {
  const m = /^([A-Z][A-Z0-9 /()-]*?): ?(.*)$/.exec(linea);
  if (!m) return null;
  if (m[1] in COLUMNAS_DE_ETIQUETA) return { etiqueta: m[1], valor: m[2] };
  if (/^FUNDING TEXT \d+$/.test(m[1])) return { etiqueta: 'FUNDING TEXT', valor: m[2] };
  return null;
}

/**
 * «(2026) Frontiers in Education, 11, 2, art. no. 1780142, pp. 1 - 9, Cited 3 times.»
 *
 * La revista puede llevar comas («Journal of Physics: Conference Series, …»),
 * así que se desmonta desde el final: lo que empieza por cifra, «art. no.» o
 * «pp.» es volumen, número, artículo o páginas, y lo que queda es la revista.
 */
function leerCita(linea) {
  const cita = {};
  let resto = linea.trim();

  const anio = /^\((\d{4})\)\s*/.exec(resto);
  if (anio) {
    cita.Year = anio[1];
    resto = resto.slice(anio[0].length);
  }

  const citado = /,?\s*Cited (\d+) times?\.?\s*$/.exec(resto);
  if (citado) {
    cita['Cited by'] = citado[1];
    resto = resto.slice(0, citado.index);
  }
  resto = resto.replace(/\.\s*$/, '');

  const trozos = resto.split(', ');
  const numeros = [];
  while (trozos.length > 1 && /^(?:\d|art\. no\.|pp?\.\s)/i.test(trozos[trozos.length - 1])) {
    numeros.unshift(trozos.pop());
  }
  cita['Source title'] = trozos.join(', ');

  const simples = [];
  for (const n of numeros) {
    const articulo = /^art\. no\.\s*(.+)$/i.exec(n);
    const paginas = /^pp?\.\s*(\S+)(?:\s*-\s*(\S+))?$/i.exec(n);
    if (articulo) cita['Art. No.'] = articulo[1];
    else if (paginas) {
      cita['Page start'] = paginas[1];
      if (paginas[2]) cita['Page end'] = paginas[2];
    } else simples.push(n);
  }
  if (simples[0]) cita.Volume = simples[0];
  if (simples[1]) cita.Issue = simples[1];

  return cita;
}

/**
 * «Duan C., Cheung S.K.S.» → «Duan C.; Cheung S.K.S.»: el CSV separa los
 * autores con punto y coma, y bibliometrix también.
 */
function autoresCortos(linea) {
  if (/^\[No author name available\]$/i.test(linea.trim())) return '';
  return linea
    .trim()
    .split(/(?<=\.),\s+/)
    .map((a) => a.trim())
    .filter(Boolean)
    .join('; ');
}

/** Un registro del texto plano, como fila del CSV. */
function leerRegistro(lineas) {
  const fila = {};
  const blanco = lineas.findIndex((l) => l.trim() === '');
  const cabeza = (blanco === -1 ? lineas : lineas.slice(0, blanco)).map((l) => l.trim());
  const cuerpo = blanco === -1 ? [] : lineas.slice(blanco + 1);

  const iCita = cabeza.findIndex((l) => /^\(\d{4}\)\s/.test(l));
  if (iCita < 1) return null;
  Object.assign(fila, leerCita(cabeza[iCita]));
  fila.Title = cabeza[iCita - 1];

  for (const [i, linea] of cabeza.entries()) {
    if (i === iCita || i === iCita - 1) continue;
    const e = etiquetaDe(linea);
    if (e) fila[COLUMNAS_DE_ETIQUETA[e.etiqueta]] = e.valor;
    else if (/^https?:\/\//.test(linea)) {
      fila.Link = linea;
      const eid = /publications\/(\d+)|eid=(2-s2\.0-\d+)/.exec(linea);
      if (eid) fila.EID = eid[2] ?? `2-s2.0-${eid[1]}`;
    } else if (/^\d+(?:;\s*\d+)*;?$/.test(linea)) fila['Author(s) ID'] = linea;
    else if (i === 0 && i < iCita - 1) fila.Authors = autoresCortos(linea);
  }

  // Los campos: cada uno en su línea, salvo las referencias, que siguen en las
  // líneas de debajo, una por referencia.
  const financiacion = [];
  const textos = [];
  let actual = null;
  for (const bruta of cuerpo) {
    const linea = bruta.replace(/\s+$/, '');
    if (linea.trim() === '') continue;
    const e = etiquetaDe(linea);
    if (e) {
      actual = e.etiqueta;
      if (actual === 'FUNDING DETAILS') financiacion.push(e.valor.trim());
      else if (actual === 'FUNDING TEXT') textos.push(e.valor.trim());
      else fila[COLUMNAS_DE_ETIQUETA[actual]] = e.valor.trim();
    } else if (actual === 'REFERENCES') {
      fila.References = `${fila.References} ${linea.trim()}`.trim();
    } else if (actual && actual !== 'FUNDING DETAILS' && actual !== 'FUNDING TEXT') {
      const columna = COLUMNAS_DE_ETIQUETA[actual];
      fila[columna] = `${fila[columna] ?? ''} ${linea.trim()}`.trim();
    }
  }
  if (financiacion.length > 0) fila['Funding Details'] = financiacion.join('; ');
  if (textos.length > 0) fila['Funding Texts'] = textos.join(' ');
  if (fila.References) fila.References = fila.References.replace(/;\s*$/, '');
  if (!fila['Cited by']) fila['Cited by'] = '0';

  return fila;
}

function campoCsv(valor) {
  return `"${String(valor ?? '').replace(/"/g, '""')}"`;
}

/**
 * El texto plano de Scopus, pasado al CSV de Scopus.
 *
 * Los registros acaban en «SOURCE: Scopus». Devuelve el CSV y cuántos
 * documentos lleva; el primer registro que no se entienda se salta, no para el
 * resto.
 */
function scopusTxtACsv(texto) {
  const lineas = sinBom(texto).split(/\r?\n/);
  let inicio = 0;
  if (/^scopus$/i.test(lineas[0]?.trim() ?? '')) inicio = 1;
  while (inicio < lineas.length && (lineas[inicio].trim() === '' || /^EXPORT DATE:/.test(lineas[inicio]))) {
    inicio += 1;
  }

  const filas = [];
  let registro = [];
  let saltados = 0;
  for (const linea of lineas.slice(inicio)) {
    if (registro.length === 0 && linea.trim() === '') continue;
    registro.push(linea);
    if (/^SOURCE: /.test(linea)) {
      const fila = leerRegistro(registro);
      if (fila) filas.push(fila);
      else saltados += 1;
      registro = [];
    }
  }

  const columnas = [...ORDEN];
  for (const fila of filas) {
    for (const c of Object.keys(fila)) if (!columnas.includes(c)) columnas.push(c);
  }
  const usadas = columnas.filter((c) => filas.some((f) => f[c] !== undefined && f[c] !== ''));

  const csv = [usadas.map(campoCsv).join(','), ...filas.map((f) => usadas.map((c) => campoCsv(f[c])).join(','))].join(
    '\n',
  );
  return { csv: `${csv}\n`, documentos: filas.length, saltados };
}

// ── Lo que se le da al motor ────────────────────────────────────────────────

/**
 * Lo mismo que `r.formato.preparar` para una matriz: el nombre con el que se
 * guarda, los bytes y la orden de R que lo lee.
 */
function preparar(bytes, tipo) {
  if (tipo === 'bibtex-otro') {
    throw new BibliografiaNoValida(
      'Ese BibTeX no viene de Scopus ni de Web of Science, y bibliometrix solo sabe leer esos dos. ' +
        'Si es tu biblioteca de Zotero o Mendeley, expórtalo desde Scopus o WoS; o sube el CSV o el ' +
        'texto plano que baja Scopus al pulsar «Exportar».',
    );
  }

  const base = BASES[tipo];
  let contenido = bytes;
  let aviso = `Es un exporte de ${base.nombre}. Se leyó con bibliometrix: \`datos\` tiene una fila por documento.`;

  if (tipo === 'scopus-txt') {
    const { csv, documentos, saltados } = scopusTxtACsv(new TextDecoder('utf-8').decode(bytes));
    if (documentos === 0) {
      throw new BibliografiaNoValida(
        'Parece un exporte de Scopus en texto plano, pero no se encontró ningún documento completo. ' +
          'Vuelve a exportarlo desde Scopus en CSV, con todos los campos.',
      );
    }
    contenido = Buffer.from(csv, 'utf8');
    aviso =
      `Es un exporte de Scopus en texto plano con ${documentos} documentos. bibliometrix no lee ese ` +
      'formato, así que se pasó a CSV con las mismas columnas y se leyó con bibliometrix: ' +
      '`datos` tiene una fila por documento.' +
      (saltados > 0 ? ` ${saltados} registros no tenían año ni revista y se dejaron fuera.` : '');
  }

  // suppressWarnings: convert2df avisa de cada campo que el exporte no trae, y
  // esos avisos taparían en la consola lo que sí importa.
  const lectura =
    `datos <- suppressWarnings(bibliometrix::convert2df("${base.archivo}", ` +
    `dbsource = "${base.dbsource}", format = "${base.format}"))`;

  return { tipo: 'bibliografia', base: tipo, archivo: base.archivo, contenido, lectura, aviso };
}

module.exports = { detectar, preparar, scopusTxtACsv, leerCita, autoresCortos, BibliografiaNoValida, BASES };
