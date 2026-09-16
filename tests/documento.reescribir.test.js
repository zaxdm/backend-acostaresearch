'use strict';

/**
 * Humanizar el Word que subió el tesista sin que «se le mueva el formato».
 *
 * Lo que se comprueba es lo que python-docx perdía al cambiar `paragraph.text`:
 * el estilo del párrafo, la letra de la corrida, las cursivas de lo que sigue
 * igual, las llamadas a nota al pie y los marcadores. Y lo que no se deja
 * reescribir: campos de Zotero, hipervínculos, imágenes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const reescritura = require('../src/modules/projects/project.reescritura');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SECCION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

function docx(cuerpo) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpo}${SECCION}</w:body></w:document>`),
  );
  zip.addFile('word/media/figura.png', Buffer.from('imagen-que-no-se-toca'));
  return zip.toBuffer();
}

const parte = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
const textos = (buffer) => documento.parrafosDe(parte(buffer)).map((x) => x.texto).filter(Boolean);

const LETRA = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="24"/></w:rPr>';
const CURSIVA = '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:i/><w:sz w:val="24"/></w:rPr>';
const PPR = '<w:pPr><w:pStyle w:val="Cuerpo"/><w:spacing w:line="480" w:lineRule="auto"/><w:ind w:firstLine="709"/><w:jc w:val="both"/></w:pPr>';

const r = (texto, rPr = LETRA) => `<w:r>${rPr}<w:t xml:space="preserve">${texto}</w:t></w:r>`;
const p = (...corridas) => `<w:p w14:paraId="1A2B3C4D" w:rsidR="00AB12CD">${PPR}${corridas.join('')}</w:p>`;

const reescribir = (cuerpo, id, texto) =>
  reescritura.reescribir(docx(cuerpo), { [id]: { original: textos(docx(cuerpo))[id - 1] ?? '', texto } });

test('conserva el formato del párrafo, la letra y la cursiva de lo que sigue igual', () => {
  const cuerpo = p(
    r('Asimismo, cabe destacar que el '),
    r('engagement', CURSIVA),
    r(' académico constituye un pilar fundamental del rendimiento.'),
  );
  const salida = reescribir(cuerpo, 1, 'El engagement académico influye en el rendimiento.');

  assert.deepEqual(textos(salida.buffer), ['El engagement académico influye en el rendimiento.']);
  const xml = parte(salida.buffer);
  // El párrafo es el mismo: su estilo, interlineado, sangría y justificado.
  assert.ok(xml.includes(`<w:p w14:paraId="1A2B3C4D" w:rsidR="00AB12CD">${PPR}`));
  // La palabra que seguía en cursiva sigue en cursiva, y el resto en su letra.
  assert.match(xml, new RegExp(`${escapar(CURSIVA)}<w:t xml:space="preserve">engagement</w:t>`));
  assert.match(xml, new RegExp(`${escapar(LETRA)}<w:t xml:space="preserve">El </w:t>`));
  assert.ok(!/<w:t[^>]*>[^<]*influye[^<]*<\/w:t>/.test(xml.split('engagement')[0]));
  assert.equal(salida.partes[1], 1);
});

test('lo añadido junto a una cursiva no sale en cursiva', () => {
  const cuerpo = p(r('Se usó el '), r('software', CURSIVA), r(' SPSS.'));
  const salida = reescribir(cuerpo, 1, 'Se usó el software estadístico SPSS.');
  const xml = parte(salida.buffer);
  assert.match(xml, new RegExp(`${escapar(LETRA)}<w:t xml:space="preserve"> estadístico SPSS\\.</w:t>`));
});

test('la llamada a nota al pie y los marcadores se quedan detrás de su palabra', () => {
  const nota = '<w:r><w:rPr><w:rStyle w:val="Refdenotaalpie"/></w:rPr><w:footnoteReference w:id="3"/></w:r>';
  const cuerpo = p(
    '<w:bookmarkStart w:id="0" w:name="_Toc1"/>',
    r('Es importante mencionar que la Ley 30364 protege a las víctimas.'),
    nota,
    '<w:bookmarkEnd w:id="0"/>',
    r(' Además, cabe destacar que exige medidas.'),
  );
  const salida = reescribir(cuerpo, 1, 'La Ley 30364 protege a las víctimas. También exige medidas.');

  assert.deepEqual(textos(salida.buffer), ['La Ley 30364 protege a las víctimas. También exige medidas.']);
  const xml = parte(salida.buffer);
  assert.ok(xml.includes(`víctimas.</w:t></w:r>${nota}<w:bookmarkEnd w:id="0"/>`), xml);
  assert.ok(xml.indexOf('<w:bookmarkStart') < xml.indexOf('La Ley'));
});

test('parte el párrafo en dos con el mismo formato; la sección se queda en el último', () => {
  const pPrConSeccion = PPR.replace('</w:pPr>', `<w:pageBreakBefore/>${SECCION}</w:pPr>`);
  const cuerpo =
    `<w:p w14:paraId="AAAA0001">${pPrConSeccion}${r('Primera idea larga. Segunda idea distinta.')}</w:p>` +
    p(r('Otro párrafo.'));

  const salida = reescritura.reescribir(docx(cuerpo), {
    1: { original: 'Primera idea larga. Segunda idea distinta.', texto: 'Primera idea larga.\n\nSegunda idea distinta.' },
  });

  assert.deepEqual(textos(salida.buffer), ['Primera idea larga.', 'Segunda idea distinta.', 'Otro párrafo.']);
  assert.equal(salida.partes[1], 2);
  const xml = parte(salida.buffer);
  const [primero, segundo] = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
  assert.match(primero, /w14:paraId="AAAA0001"/);
  assert.match(primero, /<w:pageBreakBefore\/>/);
  assert.ok(!primero.includes('<w:sectPr'));
  assert.ok(!/w14:paraId/.test(segundo));
  assert.ok(!segundo.includes('<w:pageBreakBefore'));
  assert.ok(segundo.includes('<w:sectPr'));
  assert.ok(segundo.includes('<w:ind w:firstLine="709"/>'));
});

test('también parte con la marca [APARTE]', () => {
  const salida = reescritura.reescribir(docx(p(r('Uno. Dos.'))), { 1: { original: 'Uno. Dos.', texto: 'Uno. [APARTE] Dos.' } });
  assert.deepEqual(textos(salida.buffer), ['Uno.', 'Dos.']);
});

test('no reescribe un párrafo con un campo de Zotero, un hipervínculo o una imagen', () => {
  const campo =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ADDIN ZOTERO_ITEM </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + r('(Tinto, 1975)') + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const conCampo = p(r('La deserción crece '), campo, r('.'));
  assert.match(reescritura.probar(docx(conCampo), 1, 'Crece la deserción (Tinto, 1975).').motivo, /campo/);

  const conEnlace = p(r('Ver '), `<w:hyperlink r:id="rId5">${r('el informe')}</w:hyperlink>`);
  assert.match(reescritura.probar(docx(conEnlace), 1, 'Ver el informe.').motivo, /hipervínculo/);

  const conImagen = p(r('Texto '), '<w:r><w:drawing><wp:inline/></w:drawing></w:r>');
  assert.match(reescritura.probar(docx(conImagen), 1, 'Texto.').motivo, /imagen/);

  assert.deepEqual([...reescritura.bloqueados(docx(conCampo + p(r('Libre.')))).keys()], [1]);
});

test('un párrafo que ya no es el original se salta', () => {
  const salida = reescritura.reescribir(docx(p(r('Texto nuevo del tesista.'))), {
    1: { original: 'Texto viejo.', texto: 'Otro texto.' },
  });
  assert.deepEqual(salida.saltados, [1]);
  assert.deepEqual(textos(salida.buffer), ['Texto nuevo del tesista.']);
});

test('todo lo demás del archivo sale igual, y el XML sigue equilibrado', () => {
  const entrada = docx(p(r('Uno & dos '), r('tres', CURSIVA), r(' <cuatro>.'.replace('<', '&lt;').replace('>', '&gt;'))) + p(r('Cinco.')));
  const salida = reescritura.reescribir(entrada, {
    1: { original: 'Uno & dos tres <cuatro>.', texto: 'Dos & uno, tres <cuatro>.' },
  });
  assert.deepEqual(textos(salida.buffer), ['Dos & uno, tres <cuatro>.', 'Cinco.']);
  const antes = new AdmZip(entrada);
  const despues = new AdmZip(salida.buffer);
  assert.ok(antes.getEntry('word/media/figura.png').getData().equals(despues.getEntry('word/media/figura.png').getData()));
  const xml = parte(salida.buffer);
  for (const etiqueta of ['w:p', 'w:r', 'w:t', 'w:rPr', 'w:pPr']) {
    const abre = [...xml.matchAll(new RegExp(`<${etiqueta}[ >]`, 'g'))].length;
    const cierra = [...xml.matchAll(new RegExp(`</${etiqueta}>`, 'g'))].length;
    assert.equal(abre, cierra, etiqueta);
  }
});

// ── Lo que el texto nuevo no puede cambiar ─────────────────────────────────

test('rechaza cambiar cifras, años, citas textuales, apellidos citados o añadir corchetes', () => {
  const original =
    'Según Hernández-Sampieri et al. (2018), la muestra fue de 120 docentes y el alfa de 0,89. ' +
    'Un docente dijo «no tenemos tiempo» (Pérez y Gómez, 2021).';
  const bueno =
    'La muestra fue de 120 docentes y el alfa de 0,89, según Hernández-Sampieri et al. (2018). ' +
    'Un docente dijo «no tenemos tiempo» (Pérez y Gómez, 2021).';

  assert.equal(reescritura.comprobarReescritura(original, bueno), null);
  assert.match(reescritura.comprobarReescritura(original, bueno.replace('0,89', '0,9')), /0,89/);
  assert.match(reescritura.comprobarReescritura(original, bueno.replace('(2018)', '(2019)')), /2018/);
  assert.match(reescritura.comprobarReescritura(original, bueno.replace('no tenemos tiempo', 'nos falta tiempo')), /comillas/);
  assert.match(reescritura.comprobarReescritura(original, bueno.replace('Pérez y Gómez', 'Pérez et al.')), /Gómez/);
  assert.match(reescritura.comprobarReescritura(original, `${bueno} [revisar]`), /revisar/);
  assert.match(reescritura.comprobarReescritura(original, 'La muestra fue de 120 docentes.'), /cifra|tercio/);
});

test('las marcas de cita y el punto y aparte no cuentan como texto añadido', () => {
  assert.equal(
    reescritura.comprobarReescritura('La deserción crece en 2023.', 'En 2023 la deserción crece [AR11111111].\n\nSigue.'),
    null,
  );
});

function escapar(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
