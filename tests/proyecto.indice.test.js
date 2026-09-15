'use strict';

/**
 * El índice va relleno en el Word que se descarga.
 *
 * La librería lo dejaba como un campo vacío, y en la vista protegida de Word o
 * en un visor el tesista veía «Índice» y nada debajo (15-sep-2026).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { armar } = require('../src/modules/projects/project.docx');
const { rellenarIndice } = require('../src/modules/projects/project.indice');

const LARGO = 'Un párrafo del capítulo con bastante texto para ocupar sitio en la hoja. '.repeat(12);

async function documentoArmado() {
  const salida = await armar({
    tema: 'Motivación y rendimiento',
    carrera: 'Enfermería',
    universidad: 'Universidad de prueba',
    nombre: 'ANA PÉREZ',
    capitulos: [
      { titulo: 'Capítulo I · Problema', texto: `## Realidad problemática\n\n${LARGO}\n\n## Formulación del problema\n\n${LARGO}` },
      { titulo: 'Capítulo II · Marco teórico', texto: `## Antecedentes\n\n${LARGO}` },
    ],
  });
  return new AdmZip(salida).getEntry('word/document.xml').getData().toString('utf8');
}

const indiceDe = (documento) => documento.match(/<w:sdt>[\s\S]*?<\/w:sdt>/)[0];
const entradasDe = (documento) =>
  [...indiceDe(documento).matchAll(/<w:hyperlink w:anchor="([^"]+)"[\s\S]*?<\/w:hyperlink>/g)].map((m) => {
    const textos = [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]);
    return { marca: m[1], texto: textos.slice(0, -1).join(''), numero: Number(textos[textos.length - 1]) };
  });

test('el índice trae una entrada por título, con enlace y número de página', async () => {
  const documento = await documentoArmado();
  const entradas = entradasDe(documento);

  assert.deepEqual(
    entradas.map((e) => e.texto),
    ['Capítulo I · Problema', 'Realidad problemática', 'Formulación del problema', 'Capítulo II · Marco teórico', 'Antecedentes'],
  );
  // Portada en la 1, índice en la 2: el primer capítulo empieza en la 3.
  assert.equal(entradas[0].numero, 3);
  for (let i = 1; i < entradas.length; i += 1) assert.ok(entradas[i].numero >= entradas[i - 1].numero, 'en orden');
  assert.ok(entradas[3].numero > entradas[0].numero, 'el capítulo II empieza en otra hoja');

  // Cada enlace lleva a un marcador en su título.
  for (const { marca, texto } of entradas) {
    const titulo = documento.match(new RegExp(`<w:bookmarkStart w:id="\\d+" w:name="${marca}"/>[\\s\\S]*?</w:p>`));
    assert.ok(titulo && titulo[0].includes(texto), `marcador de «${texto}»`);
  }
});

test('el campo sigue siendo el índice de Word y se actualiza al abrir', async () => {
  const indice = indiceDe(await documentoArmado());
  assert.match(indice, /<w:fldChar w:fldCharType="begin" w:dirty="true"\/><w:instrText xml:space="preserve">TOC \\h/);
  assert.equal((indice.match(/<w:fldChar w:fldCharType="begin"/g) || []).length, 1 + 5, 'el TOC y un PAGEREF por entrada');
  assert.equal((indice.match(/<w:fldChar w:fldCharType="end"\/>/g) || []).length, 1 + 5);
  assert.ok(indice.indexOf('TOC \\h') < indice.indexOf('<w:hyperlink'), 'el campo empieza antes de la primera entrada');
});

test('un índice que ya trae entradas, o un documento sin títulos, no se tocan', () => {
  const vacio =
    '<w:sdt><w:sdtContent><w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/>' +
    '<w:instrText xml:space="preserve">TOC \\h \\o "1-3"</w:instrText><w:fldChar w:fldCharType="separate"/></w:r></w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt>';
  const sinTitulos = `<w:body>${vacio}<w:p><w:r><w:t>Solo texto</w:t></w:r></w:p><w:sectPr/></w:body>`;
  assert.equal(rellenarIndice(sinTitulos, ''), sinTitulos);

  const relleno = vacio.replace('</w:p><w:p><w:r><w:fldChar w:fldCharType="end"/>', '</w:p><w:p><w:r><w:t>Capítulo I</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/>');
  const conTitulo = `<w:body>${relleno}<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Capítulo I</w:t></w:r></w:p><w:sectPr/></w:body>`;
  assert.equal(rellenarIndice(conTitulo, ''), conTitulo);
});
