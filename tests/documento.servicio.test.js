'use strict';

/**
 * El recorrido entero del documento subido, sin base ni disco: subir, leer por
 * tandas, guardar las marcas de Claude y descargarlo citado.
 *
 * Lo que importa aquí es lo que rechaza: un párrafo con una palabra cambiada,
 * una clave que no es de ninguna fuente suya, un método sin licencia.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const AdmZip = require('adm-zip');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const PROYECTO = { id: 'p1', productCode: 'METODO', estiloCitas: 'apa', idiomaCitas: 'es-ES' };
let proyecto = null;
let conLicencia = ['METODO'];

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => proyecto,
  productosConLicencia: async () => conLicencia,
  asegurar: async () => {
    proyecto = { ...PROYECTO };
    return proyecto;
  },
});

const disco = new Map();
sustituir('../src/modules/projects/project.storage', {
  guardarDocumento: async (id, buffer, ficha) => {
    disco.set(`${id}:original`, buffer);
    disco.set(`${id}:ficha`, ficha);
  },
  leerDocumento: async (id) => disco.get(`${id}:original`) ?? null,
  leerFichaDeDocumento: async (id) => disco.get(`${id}:ficha`) ?? null,
  leerCitasDeDocumento: async (id) => ({ ...(disco.get(`${id}:citas`) ?? {}) }),
  guardarCitasDeDocumento: async (id, citados) => disco.set(`${id}:citas`, citados),
  leerReescritosDeDocumento: async (id) => ({ ...(disco.get(`${id}:reescritos`) ?? {}) }),
  guardarReescritosDeDocumento: async (id, reescritos) => disco.set(`${id}:reescritos`, reescritos),
  borrarDocumento: async (id) =>
    ['original', 'ficha', 'citas', 'reescritos'].map((q) => disco.delete(`${id}:${q}`)).some(Boolean),
});

const FUENTE = {
  ref: 'AR11111111',
  itemType: 'journalArticle',
  title: 'Dropout from higher education',
  authors: 'Tinto, V.',
  year: 1975,
  source: 'Review of Educational Research',
};
sustituir('../src/modules/references/reference.service', {
  porClaves: async (claves) => (claves.includes(FUENTE.ref) ? [FUENTE] : []),
});

const servicio = require('../src/modules/projects/documento.service');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function docx(parrafos) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  const cuerpo = parrafos.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="${W}"><w:body>${cuerpo}<w:sectPr/></w:body></w:document>`));
  return zip.toBuffer();
}

test.beforeEach(() => {
  proyecto = null;
  conLicencia = ['METODO'];
  disco.clear();
});

test('sin licencia del método no se sube nada', async () => {
  conLicencia = [];
  const r = await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Uno.']), nombre: 'tesis.docx' });
  assert.equal(r, null);
  assert.equal(disco.size, 0);
});

test('recién subido se descarga tal cual, aunque la norma sea de notas al pie', async () => {
  const original = docx(['La deserción universitaria crece.']);
  await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: original, nombre: 'Mi tesis.docx' });
  proyecto.estiloCitas = 'chicago-notes-bibliography';

  const guardado = await servicio.armar('u1', 'METODO');
  assert.ok(guardado.buffer.equals(original));
  assert.match(guardado.nombreArchivo, /^mi-tesis-guardado-\d{4}-\d{2}-\d{2}\.docx$/);
});

test('subir, leer, citar con rechazos, y descargar con la cita puesta', async () => {
  const subido = await servicio.subir({
    userId: 'u1',
    productCode: 'METODO',
    buffer: docx(['La deserción universitaria crece.', 'Otra idea.']),
    nombre: 'Mi tesis.docx',
  });
  assert.equal(subido.parrafos, 2);

  const leido = await servicio.ver('u1', 'METODO');
  assert.deepEqual(leido.lineas, ['¶1 La deserción universitaria crece.', '¶2 Otra idea.']);
  assert.equal(leido.norma.nombre, 'APA 7.ª edición');

  const r = await servicio.citar('u1', 'METODO', [
    { p: 1, texto: 'La deserción universitaria crece [AR11111111].' },
    { p: 2, texto: 'Otra idea distinta [AR11111111].' },
    { p: 2, texto: 'Otra idea [ARFFFFFFFF].' },
    { p: 9, texto: 'No existe.' },
  ]);
  assert.equal(r.guardados, 1);
  assert.deepEqual(r.rechazados.map((x) => x.p), [2, 2, 9]);
  assert.match(r.rechazados[1].motivo, /ARFFFFFFFF/);
  assert.equal(r.citas, 1);

  // En la tanda siguiente Claude ve lo que ya marcó.
  assert.equal((await servicio.ver('u1', 'METODO')).lineas[0], '¶1 [citado] La deserción universitaria crece [AR11111111].');

  const citado = await servicio.armar('u1', 'METODO');
  const xml = new AdmZip(citado.buffer).getEntry('word/document.xml').getData().toString('utf8');
  assert.match(xml, /\(Tinto, 1975\)/);
  assert.match(xml, /Referencias/);
  assert.match(citado.nombreArchivo, /^mi-tesis-con-referencias-\d{4}-\d{2}-\d{2}\.docx$/);
});

test('mandar un párrafo sin marcas le quita las que tenía', async () => {
  await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Uno.']), nombre: 'a.docx' });
  await servicio.citar('u1', 'METODO', [{ p: 1, texto: 'Uno [FALTA FUENTE].' }]);
  const r = await servicio.citar('u1', 'METODO', [{ p: 1, texto: 'Uno.' }]);
  assert.equal(r.parrafos, 0);
  assert.equal(r.faltas, 0);
});

test('volver a subirlo con un párrafo nuevo delante conserva las citas', async () => {
  await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Uno.']), nombre: 'a.docx' });
  await servicio.citar('u1', 'METODO', [{ p: 1, texto: 'Uno [AR11111111].' }]);

  const otra = await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Nuevo.', 'Uno.']), nombre: 'a.docx' });
  assert.equal(otra.citados, 1);
  assert.equal(otra.perdidos, 0);
  assert.deepEqual(disco.get('p1:citas'), { 2: 'Uno [AR11111111].' });
});

test('Claude sabe que hay un documento aunque no haya nada más guardado', async () => {
  assert.equal(await servicio.aviso('u1', 'METODO'), null);
  await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Uno.']), nombre: 'a.docx' });
  assert.match(await servicio.aviso('u1', 'METODO'), /ver_mi_documento/);
});

test('con el proyecto ya creado pero sin licencia vigente tampoco se sube', async () => {
  // Que el proyecto exista no prueba nada: puede ser de una licencia caducada,
  // o creado por una plantilla antes de que esta la exigiera.
  proyecto = { ...PROYECTO };
  conLicencia = [];
  const r = await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Uno.']), nombre: 'tesis.docx' });
  assert.equal(r, null);
  assert.equal(disco.size, 0);
});

// ── Humanizar ──────────────────────────────────────────────────────────────

const xmlDe = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
const textosDe = (buffer) =>
  [...xmlDe(buffer).matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((m) =>
    [...m[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''),
  );

test('humanizar: guarda lo aprobado, rechaza lo que cambia datos, y lo descarga revisado', async () => {
  await servicio.subir({
    userId: 'u1',
    productCode: 'METODO',
    buffer: docx([
      'Asimismo, cabe destacar que la muestra estuvo constituida por 120 docentes.',
      'Es importante mencionar que el alfa fue de 0,89.',
    ]),
    nombre: 'Mi tesis.docx',
  });

  const r = await servicio.humanizar('u1', 'METODO', [
    { p: 1, texto: 'La muestra fue de 120 docentes.' },
    { p: 2, texto: 'El alfa fue de 0,9.' },
    { p: 2, texto: 'El alfa fue de 0,89 [AR11111111].' },
  ]);
  assert.equal(r.guardados, 1);
  assert.deepEqual(r.rechazados.map((x) => x.p), [2, 2]);
  assert.match(r.rechazados[0].motivo, /0,89/);
  assert.match(r.rechazados[1].motivo, /citar_mi_documento/);

  // La ronda siguiente ve el texto nuevo, marcado.
  const leido = await servicio.ver('u1', 'METODO');
  assert.equal(leido.lineas[0], '¶1 [humanizado] La muestra fue de 120 docentes.');
  assert.equal(leido.humanizados, 1);
  assert.match(await servicio.aviso('u1', 'METODO'), /humanices/);

  const armado = await servicio.armar('u1', 'METODO');
  assert.deepEqual(textosDe(armado.buffer), ['La muestra fue de 120 docentes.', 'Es importante mencionar que el alfa fue de 0,89.']);
  assert.match(armado.nombreArchivo, /^mi-tesis-revisado-\d{4}-\d{2}-\d{2}\.docx$/);
  // El Word subido no se sobrescribe: se puede volver atrás.
  assert.match(xmlDe(disco.get('p1:original')), /Asimismo/);

  const deshecho = await servicio.humanizar('u1', 'METODO', [], [1]);
  assert.equal(deshecho.deshechos, 1);
  assert.equal(deshecho.humanizados, 0);
});

test('humanizar un párrafo citado exige sus marcas, y la cita sale en el texto nuevo', async () => {
  await servicio.subir({
    userId: 'u1',
    productCode: 'METODO',
    buffer: docx(['Cabe destacar que la deserción universitaria constituye un problema creciente.']),
    nombre: 'a.docx',
  });
  await servicio.citar('u1', 'METODO', [
    { p: 1, texto: 'Cabe destacar que la deserción universitaria constituye un problema creciente [AR11111111].' },
  ]);

  const sinMarca = await servicio.humanizar('u1', 'METODO', [{ p: 1, texto: 'La deserción universitaria crece.' }]);
  assert.match(sinMarca.rechazados[0].motivo, /AR11111111/);

  const bien = await servicio.humanizar('u1', 'METODO', [{ p: 1, texto: 'La deserción universitaria crece [AR11111111].' }]);
  assert.equal(bien.guardados, 1);

  const armado = await servicio.armar('u1', 'METODO');
  assert.equal(textosDe(armado.buffer)[0], 'La deserción universitaria crece (Tinto, 1975).');
  assert.match(armado.nombreArchivo, /con-referencias/);
});

test('partir un párrafo corre los números y cada cita va con su parte', async () => {
  await servicio.subir({
    userId: 'u1',
    productCode: 'METODO',
    buffer: docx(['Primera idea del estudio. Segunda idea distinta.', 'Tercera idea.']),
    nombre: 'a.docx',
  });

  const r = await servicio.humanizar('u1', 'METODO', [
    { p: 1, texto: 'Primera idea del estudio. [APARTE] Segunda idea distinta.' },
  ]);
  assert.equal(r.partidos, 1);
  assert.equal((await servicio.ver('u1', 'METODO')).lineas[0], '¶1 [humanizado] Primera idea del estudio. [APARTE] Segunda idea distinta.');

  // Citar sobre el texto humanizado: una marca en cada parte y otra en el párrafo de detrás.
  const citado = await servicio.citar('u1', 'METODO', [
    { p: 1, texto: 'Primera idea del estudio [AR11111111]. [APARTE] Segunda idea distinta [FALTA FUENTE].' },
    { p: 2, texto: 'Tercera idea [AR11111111].' },
  ]);
  assert.equal(citado.guardados, 2, JSON.stringify(citado.rechazados));

  const armado = await servicio.armar('u1', 'METODO');
  assert.deepEqual(textosDe(armado.buffer).slice(0, 3), [
    'Primera idea del estudio (Tinto, 1975).',
    'Segunda idea distinta [falta fuente].',
    'Tercera idea (Tinto, 1975).',
  ]);
});

test('volver a subir el Word conserva lo humanizado, y el ya revisado no cuenta como perdido', async () => {
  await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Cabe destacar que crece.']), nombre: 'a.docx' });
  await servicio.humanizar('u1', 'METODO', [{ p: 1, texto: 'Crece.' }]);

  const otra = await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Nuevo.', 'Cabe destacar que crece.']), nombre: 'a.docx' });
  assert.equal(otra.humanizados, 1);
  assert.deepEqual(Object.keys(disco.get('p1:reescritos')), ['2']);

  const revisado = await servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Nuevo.', 'Crece.']), nombre: 'a.docx' });
  assert.equal(revisado.humanizados, 0);
  assert.equal(revisado.humanizadosPerdidos, 0);
});

test('partirCitado deja cada marca con su parte', () => {
  assert.deepEqual(servicio.partirCitado('Uno dos [AR11111111]. Tres [FALTA FUENTE].', [7, 6]), [
    'Uno dos [AR11111111].',
    'Tres [FALTA FUENTE].',
  ]);
});
