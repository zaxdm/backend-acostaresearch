'use strict';

/**
 * La edición de inglés académico, entregada con control de cambios.
 *
 * Lo que se fija aquí es lo que hace que el archivo SIRVA: que solo se marque
 * lo que cambió —un párrafo entero tachado es inservible—, que el `<w:pPr>` del
 * autor y el formato de cada corrida salgan intactos, que lo tachado use
 * `w:delText` y no `w:t` (o Word no lo abre), que los identificadores de
 * revisión no se repitan, y que un párrafo con una cita de Zotero o una nota al
 * pie se quede exactamente como estaba.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const cambios = require('../src/modules/preparar/preparar.cambios');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SECCION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

function docx(cuerpo) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpo}${SECCION}</w:body></w:document>`,
    ),
  );
  return zip.toBuffer();
}

const parte = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');

const LETRA = '<w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr>';
const CURSIVA = '<w:rPr><w:rFonts w:ascii="Times New Roman"/><w:i/><w:sz w:val="24"/></w:rPr>';
const PPR =
  '<w:pPr><w:pStyle w:val="Cuerpo"/><w:spacing w:line="480" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>';

const r = (texto, rPr = LETRA) => `<w:r>${rPr}<w:t xml:space="preserve">${texto}</w:t></w:r>`;
const p = (...corridas) => `<w:p w14:paraId="1A2B3C4D">${PPR}${corridas.join('')}</w:p>`;

/** El documento como lo deja Word al RECHAZAR todas las revisiones: el original. */
const rechazandoTodo = (xml) =>
  xml.replace(/<w:ins\b[\s\S]*?<\/w:ins>/g, '').replace(/w:delText/g, 'w:t');

/** Y como lo deja al ACEPTARLAS todas: el texto corregido. */
const aceptandoTodo = (xml) => xml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');

const corregir = (cuerpo, textoNuevo, opciones) => {
  const buffer = docx(cuerpo);
  const original = documento.parrafosDe(parte(buffer))[0].texto;
  return cambios.aplicar(buffer, { 1: { original, texto: textoNuevo } }, opciones);
};

// ── Lo que se marca ────────────────────────────────────────────────────────

test('solo se marca lo que cambió, no el párrafo entero', () => {
  const salida = corregir(
    p(r('The results shows that the engagement have a significant effect.')),
    'The results show that engagement has a significant effect.',
  );
  const xml = parte(salida.buffer);

  // «shows» → «show», «the engagement» → «engagement», «have» → «has».
  assert.match(xml, /<w:delText xml:space="preserve">shows <\/w:delText>/);
  assert.match(xml, /<w:t xml:space="preserve">show <\/w:t>/);

  // Y lo que no cambió sale fuera de toda revisión: «The results » abre el
  // párrafo sin `<w:ins>` ni `<w:del>` delante.
  assert.match(xml, new RegExp(`${PPR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<w:r>`));

  // Que no se haya tachado el párrafo entero: el trozo final va tal cual.
  assert.ok(!xml.includes('<w:delText xml:space="preserve">significant effect.</w:delText>'));
});

/**
 * El 24-sep-2026: comparando solo palabras, un espacio doble que se quedó en
 * uno no se veía, y el Word seguía con el espacio doble sin decir nada.
 */
test('un espacio doble que se queda en uno se marca, sin tachar las palabras', () => {
  const salida = corregir(p(r('constituted 68.5%  of the students.')), 'constituted 68.5% of the students.');
  const xml = parte(salida.buffer);

  assert.equal(salida.tocados, 1);
  assert.match(xml, /<w:delText xml:space="preserve"> <\/w:delText>/);
  assert.ok(!xml.includes('<w:delText xml:space="preserve">68.5%'), 'la cifra no se tacha');
  assert.equal(documento.parrafosDe(aceptandoTodo(xml))[0].texto, 'constituted 68.5% of the students.');
  assert.equal(documento.parrafosDe(rechazandoTodo(xml))[0].texto, 'constituted 68.5%  of the students.');
});

test('lo tachado usa w:delText y lo puesto w:t, que es lo que Word sabe abrir', () => {
  const xml = parte(corregir(p(r('An investigation about students.')), 'A study on students.').buffer);

  assert.match(xml, /<w:del [^>]*><w:r>.*?<w:delText/s);
  assert.match(xml, /<w:ins [^>]*><w:r>.*?<w:t /s);
  // Dentro de un `w:del` no puede quedar ningún `w:t`: Word lo rechaza.
  for (const bloque of xml.match(/<w:del\b[\s\S]*?<\/w:del>/g) ?? []) {
    assert.ok(!/<w:t[ >]/.test(bloque), 'un w:del no puede llevar w:t');
  }
});

test('cada revisión lleva autor, fecha y un identificador distinto', () => {
  const salida = corregir(
    p(r('The data was collected in 2019 and the sample were of 120 students.')),
    'The data were collected in 2019 and the sample was 120 students.',
    { autor: 'Acosta | IA & Research', fecha: new Date('2026-09-22T10:00:00Z') },
  );
  const xml = parte(salida.buffer);

  const ids = [...xml.matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2);
  assert.equal(new Set(ids).size, ids.length, 'los identificadores de revisión no se repiten');

  assert.match(xml, /w:author="Acosta \| IA &amp; Research"/);
  assert.match(xml, /w:date="2026-09-22T10:00:00Z"/);
});

test('un párrafo que ya estaba bien no se toca: sin revisiones y sin tocarlo', () => {
  const cuerpo = p(r('The results show a significant effect.'));
  const salida = corregir(cuerpo, 'The results show a significant effect.');
  const xml = parte(salida.buffer);

  assert.equal(salida.tocados, 0);
  assert.ok(!xml.includes('<w:ins'));
  assert.ok(!xml.includes('<w:del'));
  assert.ok(xml.includes(cuerpo), 'el XML del párrafo sale idéntico');
});

// ── Lo que se conserva ─────────────────────────────────────────────────────

test('conserva el pPr del autor: estilo, interlineado y justificado', () => {
  const xml = parte(
    corregir(p(r('The teacher realize a study.')), 'The teacher conducted a study.').buffer,
  );

  assert.ok(xml.includes(`<w:p w14:paraId="1A2B3C4D">${PPR}`));
});

test('lo que estaba en cursiva sigue en cursiva, se conserve o se tache', () => {
  const cuerpo = p(
    r('The concept of '),
    r('engagement', CURSIVA),
    r(' have been studied widely.'),
  );
  const xml = parte(corregir(cuerpo, 'The concept of engagement has been studied widely.').buffer);

  // La palabra en cursiva no cambió: sale con su formato y sin marcas.
  assert.match(xml, new RegExp(`${CURSIVA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<w:t xml:space="preserve">engagement</w:t>`));
  // Y lo tachado conserva la letra que tenía.
  assert.match(xml, /<w:delText xml:space="preserve">have <\/w:delText>/);
});

test('lo que se añade toma el formato del texto donde entra, no uno de fábrica', () => {
  const xml = parte(
    corregir(p(r('The study analyze the data.')), 'The study analyzed the data.').buffer,
  );

  const insercion = xml.match(/<w:ins [^>]*><w:r>([\s\S]*?)<w:t/);
  assert.ok(insercion, 'hay una inserción');
  assert.ok(insercion[1].includes('Times New Roman'));
});

test('el resto del documento no se toca, ni los párrafos de al lado', () => {
  const cuerpo =
    p(r('First paragraph, untouched.')) + p(r('The results shows an effect.')) + p(r('Third one.'));
  const buffer = docx(cuerpo);
  const parrafos = documento.parrafosDe(parte(buffer));

  const salida = cambios.aplicar(buffer, {
    2: { original: parrafos[1].texto, texto: 'The results show an effect.' },
  });
  const xml = parte(salida.buffer);

  assert.equal(salida.tocados, 1);
  assert.ok(xml.includes(p(r('First paragraph, untouched.'))));
  assert.ok(xml.includes(p(r('Third one.'))));
  assert.ok(xml.includes(SECCION), 'la sección final sigue ahí');
});

// ── Lo que no se toca nunca ────────────────────────────────────────────────

/**
 * Antes, una cita de Zotero bloqueaba el párrafo entero y se quedaba sin
 * corregir. En una tesis eso es casi todo el documento, así que ahora la cita
 * se aparta, se corrige el texto y la cita vuelve a su sitio con su campo
 * intacto. Ver `preparar.campos`.
 */
test('un párrafo con una cita de Zotero SÍ se corrige, y la cita sigue viva', () => {
  const campo =
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText>ADDIN ZOTERO_ITEM CSL_CITATION</w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    r('(Pérez, 2020)') +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const cuerpo = p(r('The results shows an effect '), campo, r('.'));

  const buffer = docx(cuerpo);
  const original = documento.parrafosDe(parte(buffer))[0].texto;
  const salida = cambios.aplicar(buffer, {
    1: { original, texto: 'The results show an effect (Pérez, 2020).' },
  });
  const xml = parte(salida.buffer);

  assert.equal(salida.tocados, 1);
  assert.equal(salida.intactos.size, 0);
  assert.match(xml, /<w:delText xml:space="preserve">shows <\/w:delText>/);
  assert.match(xml, /<w:ins [^>]*>[\s\S]*?show /);
  // El campo entero, una sola vez: ni duplicado como texto ni perdido.
  assert.equal(xml.split('ZOTERO_ITEM').length - 1, 1);
  assert.equal(xml.split('(Pérez, 2020)').length - 1, 1);
});

test('una llamada a nota al pie bloquea el párrafo: mal colocada deja el Word sin abrir', () => {
  const nota = '<w:r><w:rPr><w:rStyle w:val="Nota"/></w:rPr><w:footnoteReference w:id="2"/></w:r>';
  const cuerpo = p(r('The sample were of 120 students'), nota, r('.'));

  const buffer = docx(cuerpo);
  const original = documento.parrafosDe(parte(buffer))[0].texto;
  const salida = cambios.aplicar(buffer, {
    1: { original, texto: 'The sample was 120 students.' },
  });

  assert.equal(salida.tocados, 0);
  assert.match(salida.intactos.get(1), /nota al pie/);
});

test('un documento que ya venía con control de cambios no se vuelve a marcar', () => {
  const cuerpo = p('<w:ins w:id="1" w:author="Otro" w:date="2026-01-01T00:00:00Z">' + r('New text.') + '</w:ins>');

  const buffer = docx(cuerpo);
  const original = documento.parrafosDe(parte(buffer))[0].texto;
  const salida = cambios.aplicar(buffer, { 1: { original, texto: 'Newer text.' } });

  assert.equal(salida.tocados, 0);
  assert.match(salida.intactos.get(1), /control de cambios/);
});

test('si el párrafo cambió en el documento desde que se leyó, no se escribe encima', () => {
  const salida = cambios.aplicar(docx(p(r('El texto de ahora.'))), {
    1: { original: 'Otro texto que ya no está.', texto: 'Lo que fuera.' },
  });

  assert.equal(salida.tocados, 0);
  assert.match(salida.intactos.get(1), /cambió en el documento/);
});

// ── Las piezas por dentro ──────────────────────────────────────────────────

test('las operaciones juntan lo consecutivo: tres tachados seguidos son una sola revisión', () => {
  const pasos = cambios.operaciones('one two three four five', 'one five');
  const quitados = pasos.filter((paso) => paso.tipo === 'quitar');

  assert.equal(quitados.length, 1);
  assert.equal('one two three four five'.slice(quitados[0].aDesde, quitados[0].aHasta), 'two three four ');
});

test('al quitar una palabra se lleva su espacio: no queda un hueco doble', () => {
  const buffer = docx(p(r('The very important results show an effect.')));
  const original = documento.parrafosDe(parte(buffer))[0].texto;
  const salida = cambios.aplicar(buffer, {
    1: { original, texto: 'The important results show an effect.' },
  });

  const texto = documento.parrafosDe(rechazandoTodo(parte(salida.buffer)))[0].texto;
  assert.equal(texto, 'The very important results show an effect.');
  assert.match(parte(salida.buffer), /<w:delText xml:space="preserve">very <\/w:delText>/);
});

test('el texto que se lee con lo tachado dentro es el original, y sin ello es el nuevo', () => {
  const buffer = docx(p(r('The results shows an effect.')));
  const original = documento.parrafosDe(parte(buffer))[0].texto;
  const salida = cambios.aplicar(buffer, {
    1: { original, texto: 'The results show an effect.' },
  });

  const xml = parte(salida.buffer);
  // Como queda si el autor rechaza todas las correcciones: su texto de siempre.
  assert.equal(documento.parrafosDe(rechazandoTodo(xml))[0].texto, 'The results shows an effect.');
  // Y si las acepta todas: el texto corregido, sin un espacio de más.
  assert.equal(documento.parrafosDe(aceptandoTodo(xml))[0].texto, 'The results show an effect.');
});
