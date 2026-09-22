'use strict';

/**
 * Qué se considera «el cuerpo» del documento.
 *
 * Importa por dos cosas a la vez: es lo que se le cuenta al cliente y es lo que
 * se manda al modelo. Si la bibliografía entrara, se traducirían los títulos de
 * los libros y nadie podría volver a encontrarlos; si entraran las tablas, se
 * reescribirían cifras y rótulos de variable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const cuerpo = require('../src/modules/preparar/preparar.cuerpo');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docx(parrafos, estilos = '') {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${parrafos}</w:body></w:document>`),
  );
  zip.addFile(
    'word/styles.xml',
    Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}">${estilos}</w:styles>`),
  );
  return zip.toBuffer();
}

const estilo = (id, nombre) => `<w:style w:styleId="${id}"><w:name w:val="${nombre}"/></w:style>`;
const ESTILOS = estilo('Titulo1', 'heading 1') + estilo('TDC1', 'toc 1');

const p = (texto, pStyle = null) =>
  `<w:p>${pStyle ? `<w:pPr><w:pStyle w:val="${pStyle}"/></w:pPr>` : ''}` +
  `<w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;

const tabla = (...filas) =>
  `<w:tbl>${filas.map((celda) => `<w:tr><w:tc>${p(celda)}</w:tc></w:tr>`).join('')}</w:tbl>`;

const textos = (buffer) => cuerpo.cuerpoDe(buffer).parrafos.map((x) => x.texto);

// ── Contar palabras ────────────────────────────────────────────────────────

test('cuenta palabras y no signos sueltos', () => {
  assert.equal(cuerpo.palabrasDe('El rendimiento académico mejora.'), 4);
  assert.equal(cuerpo.palabrasDe('uno — dos – tres'), 3);
  assert.equal(cuerpo.palabrasDe('   '), 0);
  assert.equal(cuerpo.palabrasDe('Se midió con 3,5 puntos (p < 0.05).'), 7);
});

test('en chino cuenta caracteres: sin espacios, partir por espacios daría uno', () => {
  // Sin esto, un documento traducido al chino «encogería» a la décima parte.
  assert.equal(cuerpo.palabrasDe('学术研究的方法'), 7);
  // Tres caracteres, una palabra latina y dos caracteres: seis.
  assert.equal(cuerpo.palabrasDe('本研究 analiza 数据'), 6);
});

// ── Qué entra y qué no ─────────────────────────────────────────────────────

test('la bibliografía queda fuera: una referencia no se traduce ni se corrige', () => {
  const buffer = docx(
    p('El rendimiento académico depende de varios factores conocidos.') +
      p('Referencias', 'Titulo1') +
      p('Hernández, R. (2014). Metodología de la investigación. McGraw-Hill.') +
      p('Pérez, J. (2020). El rendimiento en la universidad. Lima: UPN.'),
    ESTILOS,
  );

  // El TÍTULO sí entra —«Referencias» se traduce a «References»— y las
  // entradas de debajo no: traducir el título de un libro publicado deja una
  // referencia que nadie puede buscar.
  assert.deepEqual(textos(buffer), [
    'El rendimiento académico depende de varios factores conocidos.',
    'Referencias',
  ]);
});

test('lo que viene después de la bibliografía, bajo otro título, vuelve a entrar', () => {
  const buffer = docx(
    p('Referencias', 'Titulo1') +
      p('Hernández, R. (2014). Metodología de la investigación. McGraw-Hill.') +
      p('Anexos', 'Titulo1') +
      p('El instrumento se aplicó en línea durante dos semanas.'),
    ESTILOS,
  );

  assert.deepEqual(textos(buffer), [
    'Referencias',
    'Anexos',
    'El instrumento se aplicó en línea durante dos semanas.',
  ]);
});

test('lo que hay dentro de una tabla son datos, no prosa: queda fuera', () => {
  const buffer = docx(
    p('La Tabla 1 resume las características de la muestra estudiada.') +
      tabla('Edad', 'M = 21.4'),
    ESTILOS,
  );

  assert.deepEqual(textos(buffer), [
    'La Tabla 1 resume las características de la muestra estudiada.',
  ]);
});

test('los rótulos y las notas de tabla y figura quedan fuera', () => {
  const buffer = docx(
    p('Tabla 3') +
      p('Figura 1') +
      p('Nota. Elaboración propia.') +
      p('Los resultados confirman la hipótesis planteada en el capítulo anterior.'),
    ESTILOS,
  );

  assert.deepEqual(textos(buffer), [
    'Los resultados confirman la hipótesis planteada en el capítulo anterior.',
  ]);
});

test('el índice queda fuera: no se traduce una línea de puntos suspensivos', () => {
  const buffer = docx(
    p('CAPÍTULO I: PROBLEMA ............ 12', 'TDC1') + p('El problema se plantea así.'),
    ESTILOS,
  );

  assert.deepEqual(textos(buffer), ['El problema se plantea así.']);
});

test('los títulos SÍ entran: también hay que traducirlos y corregirlos', () => {
  const buffer = docx(p('Planteamiento del problema', 'Titulo1') + p('El problema es este.'), ESTILOS);

  assert.deepEqual(textos(buffer), ['Planteamiento del problema', 'El problema es este.']);
});

test('los párrafos vacíos y los que no tienen ni una palabra no entran', () => {
  const buffer = docx(p('') + p('   ') + p('———') + p('Texto de verdad.'), ESTILOS);

  assert.deepEqual(textos(buffer), ['Texto de verdad.']);
});

// ── El identificador ───────────────────────────────────────────────────────

test('el identificador es el del documento entero, para poder escribir de vuelta', () => {
  // Tres párrafos: el segundo es una tabla que no entra. El tercero conserva su
  // número 3, que es por donde `project.reescritura` lo encontrará.
  const buffer = docx(p('Primero, un párrafo de prueba.') + p('Tabla 1') + p('Tercero.'), ESTILOS);
  const leido = cuerpo.cuerpoDe(buffer);

  assert.deepEqual(
    leido.parrafos.map((x) => [x.id, x.texto]),
    [
      [1, 'Primero, un párrafo de prueba.'],
      [3, 'Tercero.'],
    ],
  );
});

test('la cuenta total es la suma de lo que de verdad se va a trabajar', () => {
  const buffer = docx(
    p('Una dos tres cuatro cinco.') + tabla('seis siete ocho') + p('nueve diez.'),
    ESTILOS,
  );

  assert.equal(cuerpo.cuerpoDe(buffer).palabras, 7);
});
