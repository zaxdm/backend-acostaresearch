'use strict';

/**
 * De punta a punta sobre un .docx de verdad, con el modelo falsificado.
 *
 * Aquí no se prueba una pieza: se prueba la COSTURA entre el módulo nuevo y lo
 * que ya existía —`project.documento` para leer y `project.reescritura` para
 * escribir—, que es donde un cambio en cualquiera de los dos lados rompería el
 * servicio sin que ninguna prueba de módulo se entere.
 *
 * Lo que se fija es la promesa que se le hace al cliente: «te devolvemos tu
 * mismo Word, con tus tablas, tus figuras y tu bibliografía intactas».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const reescritura = require('../src/modules/projects/project.reescritura');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const motor = require('../src/modules/preparar/preparar.motor');
const cambios = require('../src/modules/preparar/preparar.cambios');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SECCION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
const LETRA = '<w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="24"/></w:rPr>';

const p = (texto, pStyle = null) =>
  `<w:p>${pStyle ? `<w:pPr><w:pStyle w:val="${pStyle}"/></w:pPr>` : ''}` +
  `<w:r>${LETRA}<w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;

const estilo = (id, nombre) => `<w:style w:styleId="${id}"><w:name w:val="${nombre}"/></w:style>`;

/** Una tesis en miniatura: título, prosa, una tabla, una figura y su bibliografía. */
const TESIS =
  p('Planteamiento del problema', 'Titulo1') +
  p('El rendimiento académico shows una relación con el engagement de los estudiantes.') +
  p('La muestra fue de 120 estudiantes de una universidad privada de Lima.') +
  p('Tabla 1') +
  '<w:tbl><w:tr><w:tc>' +
  p('Edad media') +
  '</w:tc><w:tc>' +
  p('21.4') +
  '</w:tc></w:tr></w:tbl>' +
  p('Nota. Elaboración propia.') +
  '<w:p><w:r><w:drawing><wp:inline><a:blip r:embed="rId5"/></wp:inline></w:drawing></w:r></w:p>' +
  p('Figura 1') +
  p('Referencias', 'Titulo1') +
  p('Hernández, R. (2014). Metodología de la investigación. McGraw-Hill.');

function docx(cuerpoXml = TESIS) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpoXml}${SECCION}</w:body></w:document>`,
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(
    `<?xml version="1.0"?><w:styles xmlns:w="${W}">${estilo('Titulo1', 'heading 1')}</w:styles>`,
  ));
  zip.addFile('word/media/figura1.png', Buffer.from('la-figura-del-tesista'));
  return zip.toBuffer();
}

const parte = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
const entradas = (buffer) => new AdmZip(buffer).getEntries().map((e) => e.entryName);

/** Un modelo que aplica `transformar` a cada párrafo que se le da. */
const modeloQue = (transformar) => async ({ mensajes }) => {
  const entrada = JSON.parse(mensajes[0].texto);
  const salida = Object.fromEntries(
    Object.entries(entrada).map(([id, texto]) => [id, transformar(texto)]),
  );
  return { texto: JSON.stringify(salida) };
};

// ── Lo que se manda al modelo ──────────────────────────────────────────────

test('al modelo solo le llega la prosa: ni la tabla, ni el rótulo, ni la bibliografía', async () => {
  const vistos = [];
  await motor.prepararParrafos({
    parrafos: cuerpo.cuerpoDe(docx()).parrafos,
    servicio: 'TRADUCCION',
    idioma: 'en',
    generar: async ({ mensajes }) => {
      const entrada = JSON.parse(mensajes[0].texto);
      vistos.push(...Object.values(entrada));
      return { texto: JSON.stringify(entrada) };
    },
    porTanda: 1000,
  });

  assert.deepEqual(vistos, [
    'Planteamiento del problema',
    'El rendimiento académico shows una relación con el engagement de los estudiantes.',
    'La muestra fue de 120 estudiantes de una universidad privada de Lima.',
    'Referencias',
  ]);
  assert.ok(!vistos.includes('21.4'), 'una celda de tabla no se traduce');
  assert.ok(!vistos.some((t) => t.startsWith('Hernández')), 'una referencia no se traduce');
});

// ── Traducción ─────────────────────────────────────────────────────────────

test('traducido: cambia la prosa y NO se mueve nada más', async () => {
  const buffer = docx();
  const { parrafos } = cuerpo.cuerpoDe(buffer);

  const { cambios: propuestos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'TRADUCCION',
    idioma: 'en',
    // Una «traducción» de mentira que conserva las cifras, que es lo que el
    // comprobador exige de una de verdad.
    generar: modeloQue((texto) => `[EN] ${texto}`),
    porTanda: 1000,
  });

  const salida = reescritura.reescribir(buffer, propuestos);
  const xml = parte(salida.buffer);

  // La prosa, traducida.
  assert.match(xml, /\[EN\] El rendimiento académico/);
  assert.match(xml, /\[EN\] Planteamiento del problema/);
  // La tabla, el rótulo, la nota y la bibliografía, intactos.
  assert.ok(xml.includes('>21.4<'));
  assert.ok(xml.includes('>Tabla 1<'));
  assert.ok(xml.includes('>Nota. Elaboración propia.<'));
  assert.ok(xml.includes('>Hernández, R. (2014). Metodología de la investigación. McGraw-Hill.<'));
  // La figura y la sección final siguen donde estaban.
  assert.ok(xml.includes('<w:drawing>'));
  assert.ok(xml.includes(SECCION));
  // Y el archivo de la imagen sigue dentro del .docx.
  assert.ok(entradas(salida.buffer).includes('word/media/figura1.png'));
});

test('lo traducido conserva la letra del tesista', async () => {
  const buffer = docx(p('El rendimiento académico mejora con el acompañamiento docente.'));
  const { parrafos } = cuerpo.cuerpoDe(buffer);

  const { cambios: propuestos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'TRADUCCION',
    idioma: 'en',
    generar: modeloQue(() => 'Academic performance improves with teaching support.'),
    porTanda: 1000,
  });

  const xml = parte(reescritura.reescribir(buffer, propuestos).buffer);
  assert.match(xml, /Times New Roman/);
  assert.match(xml, /Academic performance improves/);
});

// ── Edición con control de cambios ─────────────────────────────────────────

test('editado: las correcciones salen marcadas y el resto del Word no se toca', async () => {
  const buffer = docx();
  const { parrafos } = cuerpo.cuerpoDe(buffer);

  const { cambios: propuestos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'EDICION',
    generar: modeloQue((texto) => texto.replace('shows', 'muestra')),
    porTanda: 1000,
  });

  const hecho = cambios.aplicar(buffer, propuestos, { fecha: new Date('2026-09-22T10:00:00Z') });
  const xml = parte(hecho.buffer);

  assert.equal(hecho.tocados, 1, 'solo cambió el párrafo que tenía el error');
  assert.match(xml, /<w:delText xml:space="preserve">shows <\/w:delText>/);
  assert.match(xml, /<w:ins [^>]*><w:r>.*?<w:t [^>]*>muestra <\/w:t>/s);

  // Todo lo demás, intacto.
  assert.ok(xml.includes('>21.4<'));
  assert.ok(xml.includes('>Hernández, R. (2014). Metodología de la investigación. McGraw-Hill.<'));
  assert.ok(xml.includes('<w:drawing>'));
  assert.ok(entradas(hecho.buffer).includes('word/media/figura1.png'));
});

test('un párrafo que el modelo estropeó no llega al Word', async () => {
  const buffer = docx();
  const { parrafos } = cuerpo.cuerpoDe(buffer);

  const { cambios: propuestos, malos } = await motor.prepararParrafos({
    parrafos,
    servicio: 'EDICION',
    // Se inventa otra muestra: 120 → 150. Es el error que arruina una tesis.
    generar: modeloQue((texto) => texto.replace('120', '150')),
    porTanda: 1000,
  });

  const xml = parte(cambios.aplicar(buffer, propuestos).buffer);

  assert.ok(malos.some((m) => /cifras/.test(m.motivo)));
  assert.ok(xml.includes('La muestra fue de 120 estudiantes'), 'el párrafo original sigue ahí');
  assert.ok(!xml.includes('150'));
});

// ── Resúmenes ──────────────────────────────────────────────────────────────

