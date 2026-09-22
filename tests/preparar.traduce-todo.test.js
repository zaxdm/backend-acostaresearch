'use strict';

/**
 * Traducir es traducir TODO el documento.
 *
 * DE DÓNDE SALE ESTA PRUEBA
 * -------------------------
 * De una entrega real. El cliente recibió su tesis «traducida al inglés» y le
 * llegó con los dos anexos enteros en español —la matriz de consistencia y la
 * de operacionalización, que son tablas de cabo a rabo— y con un aviso que
 * decía que cinco párrafos «llevaban dentro una nota al pie, una ecuación o una
 * imagen». Ese documento no tenía ni una sola nota al pie: la frase estaba
 * escrita a mano en la web y salía igual pasara lo que pasara.
 *
 * De las 1.649 palabras de prosa del documento, 628 no se le llegaron a mandar
 * al modelo: 519 dentro de tablas y 109 en rótulos de tabla y figura.
 *
 * LO QUE SE FIJA AQUÍ
 * -------------------
 *   · Las celdas de una tabla se traducen. Es donde vive media tesis peruana.
 *   · Los rótulos y las notas de tabla y figura también, conservando el número.
 *   · Las notas al pie, las notas al final, el encabezado y el pie de página
 *     viven en otros archivos del .docx y también se traducen.
 *   · La bibliografía NO se traduce, en ningún caso: un título traducido es un
 *     libro que ya no se puede encontrar.
 *   · Corregir el inglés y resumir siguen trabajando solo sobre el cuerpo.
 *   · Lo que quede sin hacer se cuenta CON SU MOTIVO de verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const partes = require('../src/modules/preparar/preparar.partes');
const motor = require('../src/modules/preparar/preparar.motor');
const traduccion = require('../src/modules/preparar/preparar.traduccion');
const servicio = require('../src/modules/preparar/preparar.service');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const t = (texto) => `<w:r><w:t xml:space="preserve">${texto}</w:t></w:r>`;
const p = (texto) => `<w:p>${t(texto)}</w:p>`;

/** Una tabla de una fila con una celda por texto. */
const tabla = (...celdas) =>
  `<w:tbl>${celdas.map((texto) => `<w:tc>${p(texto)}</w:tc>`).join('')}</w:tbl>`;

const titulo = (texto) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${t(texto)}</w:p>`;

const ESTILOS =
  `<?xml version="1.0"?><w:styles xmlns:w="${W}">` +
  '<w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '</w:styles>';

/** Un .docx con las partes que se le pasen, además del cuerpo. */
function docx(cuerpoXml, otras = {}) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpoXml}</w:body></w:document>`,
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(ESTILOS));

  for (const [nombre, dentro] of Object.entries(otras)) {
    zip.addFile(
      nombre,
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:root xmlns:w="${W}">${dentro}</w:root>`),
    );
  }
  return zip.toBuffer();
}

const leerParte = (buffer, nombre) =>
  new AdmZip(buffer).getEntry(nombre).getData().toString('utf8');

/** Un modelo que aplica `transformar` a cada párrafo que se le manda. */
const modeloQue = (transformar) => async ({ mensajes }) => {
  const entrada = JSON.parse(mensajes[0].texto);
  return {
    texto: JSON.stringify(
      Object.fromEntries(Object.entries(entrada).map(([id, texto]) => [id, transformar(texto)])),
    ),
  };
};

/** El recorrido entero de una traducción, con el alcance que de verdad usa el servicio. */
async function traducirTodo(buffer, transformar = (texto) => `[EN] ${texto}`) {
  const { parrafos, palabras } = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('TRADUCCION'));
  const { cambios, malos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'TRADUCCION',
    idioma: 'en',
    generar: modeloQue(transformar),
    porTanda: 10_000,
  });
  const hecho = traduccion.traducir(buffer, cambios, parrafos);
  return { ...hecho, parrafos, palabras, malos };
}

// ── Las tablas ─────────────────────────────────────────────────────────────

test('las celdas de una tabla se traducen', async () => {
  const buffer = docx(
    p('La matriz resume el estudio.') +
      tabla('Problema general', 'Objetivo general', 'Hipótesis general'),
  );

  const hecho = await traducirTodo(buffer);
  const xml = leerParte(hecho.buffer, 'word/document.xml');

  assert.equal(hecho.tocados, 4);
  assert.match(xml, /\[EN\] Problema general/);
  assert.match(xml, /\[EN\] Objetivo general/);
  assert.match(xml, /\[EN\] Hipótesis general/);
});

test('corregir el inglés sigue sin meterse en las tablas', async () => {
  const buffer = docx(p('The study shows an effect.') + tabla('Variable', 'Indicador'));

  const soloElCuerpo = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('EDICION'));
  const todo = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('TRADUCCION'));

  assert.deepEqual(soloElCuerpo.parrafos.map((x) => x.texto), ['The study shows an effect.']);
  assert.equal(todo.parrafos.length, 3);
});

// ── Los rótulos y sus notas ────────────────────────────────────────────────

test('el rótulo de una tabla se traduce y el número no se mueve', async () => {
  const buffer = docx(
    p('Tabla 3') + p('Nota. Elaboración propia.') + p('El análisis confirma lo anterior.'),
  );

  const hecho = await traducirTodo(buffer, (texto) => texto.replace('Tabla', 'Table').replace('Nota.', 'Note.'));
  const xml = leerParte(hecho.buffer, 'word/document.xml');

  assert.match(xml, /Table 3/);
  assert.match(xml, /Note\. Elaboración propia\./);
});

test('un rótulo cuyo número cambia no entra en el documento', async () => {
  const buffer = docx(p('Tabla 3') + p('El análisis confirma lo anterior.'));

  // El modelo renumera el rótulo: eso desalinea el texto que lo cita.
  const hecho = await traducirTodo(buffer, (texto) =>
    texto === 'Tabla 3' ? 'Table 4' : `[EN] ${texto}`);
  const xml = leerParte(hecho.buffer, 'word/document.xml');

  assert.equal(hecho.tocados, 1);
  assert.match(xml, /Tabla 3/);
  assert.match(hecho.malos[0].motivo, /cifras/);
});

// ── Las demás partes del .docx ─────────────────────────────────────────────

test('las notas al pie, el encabezado y el pie de página también se traducen', async () => {
  const buffer = docx(p('El cuerpo del trabajo.'), {
    'word/footnotes.xml':
      '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
      `<w:footnote w:id="1">${p('Dato recogido en campo durante el trabajo.')}</w:footnote>`,
    'word/header1.xml': p('Usabilidad percibida de la aplicación'),
    'word/footer1.xml': p('Escuela de Ingeniería'),
  });

  const hecho = await traducirTodo(buffer);

  assert.equal(hecho.tocados, 4);
  assert.match(leerParte(hecho.buffer, 'word/footnotes.xml'), /\[EN\] Dato recogido en campo/);
  assert.match(leerParte(hecho.buffer, 'word/header1.xml'), /\[EN\] Usabilidad percibida/);
  assert.match(leerParte(hecho.buffer, 'word/footer1.xml'), /\[EN\] Escuela de Ingeniería/);

  // La nota de mentira que Word guarda para la rayita no lleva texto y no se toca.
  assert.match(leerParte(hecho.buffer, 'word/footnotes.xml'), /<w:separator\/>/);
});

test('el título que corre en el encabezado se traduce con su número de página al lado', async () => {
  // El número de página es un campo de Word cuyo resultado está vacío: no hay
  // texto por el que reconocerlo, así que se conserva en su sitio tal cual.
  const paginado =
    '<w:p>' + t('Usabilidad percibida') +
    '<w:r><w:fldChar w:fldCharType="begin"/><w:instrText xml:space="preserve">PAGE</w:instrText>' +
    '<w:fldChar w:fldCharType="separate"/><w:fldChar w:fldCharType="end"/></w:r>' + '</w:p>';

  const buffer = docx(p('El cuerpo del trabajo.'), { 'word/header1.xml': paginado });
  const hecho = await traducirTodo(buffer);
  const encabezado = leerParte(hecho.buffer, 'word/header1.xml');

  assert.equal(hecho.intactos.size, 0);
  assert.match(encabezado, /\[EN\] Usabilidad percibida/);
  assert.match(encabezado, /<w:instrText xml:space="preserve">PAGE<\/w:instrText>/);
  assert.match(encabezado, /w:fldCharType="begin"/);
  assert.match(encabezado, /w:fldCharType="end"/);
});

test('cada párrafo de fuera del cuerpo lleva de dónde sale en su clave', async () => {
  const buffer = docx(p('El cuerpo del trabajo.'), {
    'word/footnotes.xml': `<w:footnote w:id="1">${p('Una nota.')}</w:footnote>`,
    'word/footer1.xml': p('Un pie.'),
  });

  const { parrafos } = cuerpo.cuerpoDe(buffer, { todo: true });
  const claves = parrafos.map((x) => x.clave);

  // El cuerpo primero y las demás partes por orden de archivo, siempre igual:
  // el número de un párrafo no puede cambiar entre que se cuenta y que se
  // escribe.
  assert.deepEqual(claves, ['1', 'pie1:1', 'nota:1']);
  assert.equal(partes.donde(parrafos[1].parte), 'el pie de página');
  assert.equal(partes.donde(parrafos[2].parte), 'las notas al pie');
});

test('los comentarios del asesor no se traducen', async () => {
  const buffer = docx(p('El cuerpo del trabajo.'), {
    'word/comments.xml': `<w:comment w:id="1">${p('Revisa esta cita, por favor.')}</w:comment>`,
  });

  const hecho = await traducirTodo(buffer);

  assert.equal(hecho.tocados, 1);
  assert.match(leerParte(hecho.buffer, 'word/comments.xml'), /Revisa esta cita, por favor\./);
});

// ── Lo que sigue sin traducirse, y a propósito ─────────────────────────────

test('la bibliografía se queda en su idioma, tablas o no', async () => {
  const buffer = docx(
    p('El estudio se apoya en la literatura.') +
      titulo('Referencias') +
      p('Hernández, R. (2014). Metodología de la investigación. McGraw-Hill.'),
  );

  const hecho = await traducirTodo(buffer);
  const xml = leerParte(hecho.buffer, 'word/document.xml');

  // El título «Referencias» sí se traduce —es un título—, la lista que cuelga
  // de él no.
  assert.equal(hecho.tocados, 2);
  assert.match(xml, /\[EN\] Referencias/);
  assert.match(xml, /Metodología de la investigación/);
  assert.doesNotMatch(xml, /\[EN\] Hernández/);
});

// ── El motivo que se le dice al cliente ────────────────────────────────────

test('los avisos dicen el motivo de verdad y de qué parte del documento salen', () => {
  const parrafos = [
    { clave: '3', parte: partes.PRINCIPAL, id: 3, texto: 'Diversas razones sustentan la pertinencia del estudio.' },
    { clave: '4', parte: partes.PRINCIPAL, id: 4, texto: 'No aplica al diseño descriptivo.' },
    { clave: 'nota:1', parte: 'word/footnotes.xml', id: 1, texto: 'Dato recogido en campo.' },
  ];

  const avisos = servicio.motivosDe({
    parrafos,
    malos: [
      { id: '3', motivo: 'el modelo no devolvió este párrafo' },
      { id: '4', motivo: 'el modelo no devolvió este párrafo' },
    ],
    intactos: new Map([['nota:1', 'tiene control de cambios sin aceptar']]),
  });

  assert.deepEqual(avisos, [
    {
      donde: 'el cuerpo del documento',
      motivo: 'el modelo no devolvió este párrafo',
      cuantos: 2,
      ejemplo: 'Diversas razones sustentan la pertinencia del estudio.',
    },
    {
      donde: 'las notas al pie',
      motivo: 'tiene control de cambios sin aceptar',
      cuantos: 1,
      ejemplo: 'Dato recogido en campo.',
    },
  ]);
});

test('ningún aviso inventa una nota al pie que el documento no tiene', () => {
  const avisos = servicio.motivosDe({
    parrafos: [{ clave: '1', parte: partes.PRINCIPAL, id: 1, texto: 'Un párrafo.' }],
    malos: [{ id: '1', motivo: 'el modelo devolvió el párrafo vacío' }],
  });

  assert.equal(avisos.length, 1);
  assert.doesNotMatch(avisos[0].motivo, /nota al pie|ecuación|imagen/);
});

// ── La cuenta de palabras ──────────────────────────────────────────────────

test('la cuenta que se le enseña al cliente es la del trabajo que se va a hacer', () => {
  const buffer = docx(
    p('Una frase de cuatro palabras.') + tabla('Problema general'),
    { 'word/footer1.xml': p('Escuela de Ingeniería') },
  );

  const traduciendo = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('TRADUCCION'));
  const corrigiendo = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('EDICION'));

  assert.equal(corrigiendo.palabras, 5);
  assert.equal(traduciendo.palabras, 5 + 2 + 3);
});
