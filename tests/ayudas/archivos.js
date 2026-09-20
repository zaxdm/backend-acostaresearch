'use strict';

/**
 * Archivos de verdad para las pruebas: un PDF y un Excel hechos a mano.
 *
 * Se arman byte a byte, sin librerías que los generen, porque lo que se prueba
 * es justamente la lectura: si el que escribe y el que lee fueran el mismo
 * paquete, la prueba solo diría que ese paquete es consistente consigo mismo.
 */

const AdmZip = require('adm-zip');

/** Un PDF mínimo, con una línea de texto por elemento de `lineas` (una página cada `porPagina`). */
function pdfCon(lineas, { porPagina = 40 } = {}) {
  const paginas = [];
  for (let i = 0; i < lineas.length; i += porPagina) paginas.push(lineas.slice(i, i + porPagina));
  if (paginas.length === 0) paginas.push([]);

  const objetos = [];
  const agregar = (cuerpo) => objetos.push(cuerpo) && objetos.length;
  const catalogo = agregar(null);
  const arbol = agregar(null);
  const fuente = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const hijos = [];
  for (const pagina of paginas) {
    const escapar = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const flujo = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td', ...pagina.map((l) => `(${escapar(l)}) Tj T*`), 'ET'].join('\n');
    const contenido = agregar(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
    hijos.push(
      agregar(
        `<< /Type /Page /Parent ${arbol} 0 R /MediaBox [0 0 595 842] ` +
          `/Resources << /Font << /F1 ${fuente} 0 R >> >> /Contents ${contenido} 0 R >>`,
      ),
    );
  }
  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${arbol} 0 R >>`;
  objetos[arbol - 1] = `<< /Type /Pages /Kids [${hijos.map((h) => `${h} 0 R`).join(' ')}] /Count ${hijos.length} >>`;

  let salida = '%PDF-1.4\n';
  const posiciones = [];
  objetos.forEach((cuerpo, i) => {
    posiciones.push(Buffer.byteLength(salida, 'latin1'));
    salida += `${i + 1} 0 obj\n${cuerpo}\nendobj\n`;
  });
  const xref = Buffer.byteLength(salida, 'latin1');
  salida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const p of posiciones) salida += `${String(p).padStart(10, '0')} 00000 n \n`;
  salida += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(salida, 'latin1');
}

const escaparXml = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COLUMNAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Un .xlsx como el que guarda Excel: el texto va en la tabla de cadenas
 * compartidas y los números, sueltos en la celda. `hojas` es
 * `[{ nombre, filas: [[celda, …], …] }]`; una celda `null` queda vacía.
 *
 * Las hojas se guardan en orden inverso al de sus pestañas —`sheet1.xml` es la
 * última— para que se note si alguien lee los archivos por su número en vez de
 * seguir las relaciones del libro.
 */
function excelCon(hojas) {
  const cadenas = [];
  const numeroDeCadena = (texto) => {
    const existente = cadenas.indexOf(texto);
    if (existente !== -1) return existente;
    cadenas.push(texto);
    return cadenas.length - 1;
  };

  const archivos = hojas
    .map((hoja, i) => ({ hoja, archivo: `hoja${hojas.length - i}.xml`, id: `rId${i + 1}` }))
    .map(({ hoja, archivo, id }) => {
      const filas = hoja.filas
        .map((celdas, f) => {
          const xml = celdas
            .map((valor, c) => {
              if (valor === null || valor === undefined || valor === '') return '';
              const ref = `${COLUMNAS[c]}${f + 1}`;
              return typeof valor === 'number'
                ? `<c r="${ref}"><v>${valor}</v></c>`
                : `<c r="${ref}" t="s"><v>${numeroDeCadena(String(valor))}</v></c>`;
            })
            .join('');
          return `<row r="${f + 1}">${xml}</row>`;
        })
        .join('');
      return {
        id,
        archivo,
        nombre: hoja.nombre,
        xml:
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData>${filas}</sheetData></worksheet>`,
      };
    });

  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdLibro" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
  );
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        archivos
          .map(({ nombre, id }, i) => `<sheet name="${escaparXml(nombre)}" sheetId="${i + 1}" r:id="${id}"/>`)
          .join('') +
        '</sheets></workbook>',
    ),
  );
  zip.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        archivos
          .map(
            ({ id, archivo }) =>
              `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${archivo}"/>`,
          )
          .join('') +
        '</Relationships>',
    ),
  );
  for (const { archivo, xml } of archivos) zip.addFile(`xl/worksheets/${archivo}`, Buffer.from(xml));
  zip.addFile(
    'xl/sharedStrings.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${cadenas.length}" uniqueCount="${cadenas.length}">` +
        cadenas.map((texto) => `<si><t>${escaparXml(texto)}</t></si>`).join('') +
        '</sst>',
    ),
  );

  return zip.toBuffer();
}

module.exports = { pdfCon, excelCon };
