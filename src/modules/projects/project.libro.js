'use strict';

/**
 * Un libro de Excel (.xlsx) armado aquí, para las fichas de trabajo del artículo.
 *
 * POR QUÉ EXISTE
 * --------------
 * La Matriz de Estrategia (Fase 1) y la matriz de trazabilidad de las citas las
 * armaba Claude con los scripts de la skill, que por el conector no existen: en
 * claude.ai reescribía el script (veinte minutos) y le decía al autor «el
 * método arma este Excel con un script que no tengo aquí»; el archivo quedaba
 * en ese chat y en ChatGPT o Grok no salía (E2E del 7-nov-2026). Aquí sale en
 * el servidor, queda en la carpeta del proyecto y se puede volver a pedir.
 *
 * Se escribe a mano, como se lee en `project.hoja`: hace falta muy poco (texto
 * en celdas, la primera fila en negrita y el ancho de las columnas).
 */

const AdmZip = require('adm-zip');

/** Excel no admite más de 31 caracteres ni estos signos en el nombre de una hoja. */
const LARGO_NOMBRE = 31;
const ANCHO_MAXIMO = 70;

const escapar = (valor) =>
  String(valor ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** «A», «B», … «Z», «AA»: la letra de la columna n (desde 0). */
function letra(n) {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Nombres de hoja válidos y sin repetir: Excel no abre un libro con dos iguales. */
function nombresDeHoja(nombres) {
  const usados = new Set();
  return nombres.map((nombre, i) => {
    let base = String(nombre ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || `Hoja ${i + 1}`;
    base = base.slice(0, LARGO_NOMBRE).trim();
    let final = base;
    for (let n = 2; usados.has(final.toLowerCase()); n += 1) {
      const sufijo = ` (${n})`;
      final = base.slice(0, LARGO_NOMBRE - sufijo.length).trim() + sufijo;
    }
    usados.add(final.toLowerCase());
    return final;
  });
}

function hojaXml(filas) {
  const columnas = Math.max(1, ...filas.map((f) => f.length));
  const anchos = Array.from({ length: columnas }, (_, c) =>
    Math.min(ANCHO_MAXIMO, Math.max(10, ...filas.map((f) => String(f[c] ?? '').length + 2))),
  );
  const cols = anchos.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('');
  const filasXml = filas
    .map((fila, r) => {
      const celdas = fila
        .map((valor, c) => {
          if (valor === null || valor === undefined || valor === '') return '';
          const estilo = r === 0 ? 1 : 2;
          return `<c r="${letra(c)}${r + 1}" t="inlineStr" s="${estilo}"><is><t xml:space="preserve">${escapar(valor)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${celdas}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${filasXml}</sheetData></worksheet>`
  );
}

const ESTILOS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * El .xlsx. `hojas`: [{ nombre, filas: [[celda, …], …] }]; la primera fila de
 * cada hoja es el encabezado (en negrita, fija al bajar).
 */
function libro(hojas) {
  const lista = hojas.length > 0 ? hojas : [{ nombre: 'Hoja 1', filas: [['(vacía)']] }];
  const nombres = nombresDeHoja(lista.map((h) => h.nombre));
  const zip = new AdmZip();
  const poner = (ruta, xml) => zip.addFile(ruta, Buffer.from(xml, 'utf8'));

  poner(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      lista
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('') +
      '</Types>',
  );
  poner(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );
  poner(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      nombres.map((n, i) => `<sheet name="${escapar(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  poner(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      lista
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('') +
      `<Relationship Id="rId${lista.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  poner('xl/styles.xml', ESTILOS);
  lista.forEach((h, i) => poner(`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h.filas.length > 0 ? h.filas : [['(vacía)']])));

  return zip.toBuffer();
}

/** Una línea de tabla Markdown en celdas, sin las barras de los bordes ni el formato. */
function celdas(linea) {
  return linea
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => sinFormato(c.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n')));
}

/** Sin las negritas ni las cursivas de Markdown: en una celda saldrían los asteriscos. */
function sinFormato(texto) {
  return texto
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1$2')
    .trim();
}

const esSeparador = (linea) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(linea);
const esFilaDeTabla = (linea) => /^\s*\|.*\|\s*$/.test(linea);

/**
 * Las hojas de un texto en Markdown: una por título `##` (o `#`) con su tabla.
 *
 * Así guarda Claude la Matriz con `guardar_capitulo`: «## 1. Diseño y muestra»
 * y una tabla debajo, y así cinco. Una sección sin tabla sale como una columna
 * con sus líneas, para no perder nada. El texto antes del primer título, si lo
 * hay, va en una hoja «Notas».
 */
function hojasDeMarkdown(texto) {
  const secciones = [];
  let actual = { nombre: 'Notas', lineas: [] };
  for (const linea of String(texto ?? '').replace(/\r/g, '').split('\n')) {
    const titulo = linea.match(/^#{1,3}\s+(.+?)\s*#*\s*$/);
    if (titulo) {
      secciones.push(actual);
      actual = { nombre: titulo[1].replace(/\*\*/g, '').trim(), lineas: [] };
      continue;
    }
    actual.lineas.push(linea);
  }
  secciones.push(actual);

  const hojas = [];
  for (const { nombre, lineas } of secciones) {
    const tabla = [];
    const sueltas = [];
    for (const linea of lineas) {
      if (esFilaDeTabla(linea)) {
        if (!esSeparador(linea)) tabla.push(celdas(linea));
      } else if (linea.trim()) {
        sueltas.push(sinFormato(linea.trim().replace(/^[-*]\s+/, '')));
      }
    }
    if (tabla.length === 0 && sueltas.length === 0) continue;
    const filas = tabla.length > 0 ? tabla : [[nombre], ...sueltas.map((s) => [s])];
    // Las líneas sueltas junto a una tabla (una nota, una aclaración) van debajo.
    if (tabla.length > 0 && sueltas.length > 0) filas.push([], ...sueltas.map((s) => [s]));
    hojas.push({ nombre, filas });
  }
  return hojas;
}

module.exports = { libro, hojasDeMarkdown, nombresDeHoja, letra };
