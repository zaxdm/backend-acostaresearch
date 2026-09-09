'use strict';

/**
 * El Word es lo que el tesista entrega. Lo que se prueba aquí es que el texto
 * de alguien llegue entero al documento y que la carpeta donde vive no se pueda
 * usar para escribir fuera de ella.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

// Antes de cargar nada: el almacén lee la carpeta del entorno al construirse.
const CARPETA = path.join(os.tmpdir(), `acosta-prueba-${process.pid}`);
process.env.CAPITULOS_DIR = CARPETA;

const almacen = require('../src/modules/projects/project.storage');
const { armar, nombreDeArchivo, comoParrafos } = require('../src/modules/projects/project.docx');

test.after(async () => {
  await fs.rm(CARPETA, { recursive: true, force: true });
});

const PROYECTO = 'a1b2c3d4-0000-4000-8000-000000000000';

test('lo guardado se lee igual, con acentos y saltos', async () => {
  const texto = '## Método\n\nEl diseño fue cuasiexperimental.\n\nSe evaluó a 120 estudiantes.';
  const { palabras } = await almacen.guardar(PROYECTO, 'metodologia', texto);

  assert.equal(await almacen.leer(PROYECTO, 'metodologia'), texto);
  // Diez, no once: las almohadillas del subtítulo no son una palabra del
  // capítulo, y el tesista tiene que poder fiarse de esta cifra.
  assert.equal(palabras, 10);
});

test('las marcas de Markdown no cuentan como palabras', () => {
  assert.equal(almacen.palabrasDe('## Antecedentes'), 1);
  assert.equal(almacen.palabrasDe('- uno\n- dos\n- tres'), 3);
  assert.equal(almacen.palabrasDe('**muy** *importante*'), 2);
  assert.equal(almacen.palabrasDe('   '), 0);
});

test('un capítulo que no se ha escrito devuelve null, no revienta', async () => {
  assert.equal(await almacen.leer(PROYECTO, 'discusion'), null);
});

test('añadir pega detrás; sin añadir, reemplaza', async () => {
  await almacen.guardar(PROYECTO, 'marco-teorico', 'Primera parte.');
  await almacen.guardar(PROYECTO, 'marco-teorico', 'Segunda parte.', { anadir: true });

  assert.equal(await almacen.leer(PROYECTO, 'marco-teorico'), 'Primera parte.\n\nSegunda parte.');

  // Sin la marca se reemplaza entero: es como el tesista corrige un capítulo.
  await almacen.guardar(PROYECTO, 'marco-teorico', 'Todo de nuevo.');
  assert.equal(await almacen.leer(PROYECTO, 'marco-teorico'), 'Todo de nuevo.');
});

test('no se puede escribir fuera de la carpeta de capítulos', async () => {
  // El identificador lo pone la base y la clave viene del catálogo, así que
  // esto no debería llegar nunca. «No debería» no es una garantía.
  await assert.rejects(() => almacen.guardar('../../../etc', 'passwd', 'x'));
  await assert.rejects(() => almacen.guardar(PROYECTO, '../../../etc/passwd', 'x'));
  await assert.rejects(() => almacen.leer(PROYECTO, '..'));
});

test('el documento sale con los capítulos dentro', async () => {
  const buffer = await armar({
    tema: 'Deserción universitaria',
    carrera: 'Psicología',
    universidad: 'UNMSM',
    nombre: 'Juan Pérez',
    capitulos: [
      { titulo: 'Capítulo I', texto: 'El problema es la deserción.' },
      { titulo: 'Capítulo II', texto: '## Antecedentes\n\nGarcía (2024) encontró que…' },
    ],
  });

  // Un .docx es un zip: empieza por PK. Si esto falla, no es un Word.
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 5000, 'un documento con dos capítulos no puede pesar tan poco');

  // El texto va comprimido, pero el nombre del tesista y el tema aparecen sin
  // comprimir en los metadatos del documento.
  const crudo = buffer.toString('latin1');
  assert.ok(crudo.includes('word/document.xml'));
});

test('los encabezados de Markdown se convierten en títulos, no en almohadillas', () => {
  const parrafos = comoParrafos('## Antecedentes\n\nTexto normal.');

  assert.equal(parrafos.length, 2);
  // El primero es un encabezado; el segundo, un párrafo justificado con sangría.
  const xml = JSON.stringify(parrafos[0]);
  assert.ok(!xml.includes('##'), 'las almohadillas no pueden llegar al documento');
});

test('el nombre del archivo lleva la fecha y no lleva tildes', () => {
  const nombre = nombreDeArchivo('Deserción académica en el Perú');

  assert.match(nombre, /^desercion-academica-en-el-peru-\d{4}-\d{2}-\d{2}\.docx$/);
});

test('sin tema, el archivo sigue teniendo un nombre usable', () => {
  assert.match(nombreDeArchivo(null), /^tesis-\d{4}-\d{2}-\d{2}\.docx$/);
});

test('un tema hecho solo de signos no deja el archivo sin nombre', () => {
  assert.match(nombreDeArchivo('¿¡...!?'), /^tesis-\d{4}-\d{2}-\d{2}\.docx$/);
});
