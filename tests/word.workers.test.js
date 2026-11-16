'use strict';

/** El cambio de hilo conserva cada parte del Word y deja atender otros timers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const AdmZip = require('adm-zip');
const { PNG } = require('pngjs');

const { crearPoolWord } = require('../src/lib/wordPool');
const { armarDirecto } = require('../src/modules/projects/word.generacion');
const csl = require('../src/modules/projects/project.csl');
const citas = require('../src/modules/projects/project.citas');
const documento = require('../src/modules/projects/project.docx');
const subido = require('../src/modules/projects/project.documento');
const reescritura = require('../src/modules/projects/project.reescritura');
const zoteroCampos = require('../src/modules/projects/project.zotero-campos');
const mendeleyCampos = require('../src/modules/projects/project.mendeley-campos');
const { instalar } = require('./fixtures/word.entropia');
const { proyecto, docx } = require('./fixtures/word.datos');

const parte = (buffer, nombre) => new AdmZip(buffer).getEntry(nombre)?.getData().toString('utf8');

function compararPartes(esperado, recibido) {
  assert.ok(Buffer.isBuffer(recibido), 'el pool devuelve un Buffer, no el Uint8Array de structuredClone');
  const a = new AdmZip(esperado);
  const b = new AdmZip(recibido);
  const nombres = (zip) => zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName).sort();
  assert.deepEqual(nombres(b), nombres(a), 'las mismas partes y relaciones del paquete');
  for (const nombre of nombres(a)) {
    // No se normalizan ni XML ni IDs: la fecha/entropía están fijas en el fixture.
    assert.deepEqual(b.getEntry(nombre).getData(), a.getEntry(nombre).getData(), `${nombre}: igual byte a byte`);
  }
}

async function conEntropiaFija(armar) {
  const entropia = instalar();
  try {
    entropia.reiniciar();
    return await armar();
  } finally {
    entropia.restaurar();
  }
}

/** Pipeline anterior explícito: citeproc + project.docx, sin word.generacion. */
async function proyectoAnterior(datos) {
  const porClave = new Map(datos.fuentes.map((f) => [f.ref, f]));
  const r = csl.renderizar({
    norma: datos.estiloCitas, idioma: datos.idiomaCitas,
    capitulos: datos.capitulos, porClave,
    ...(datos.uris ? { urisDe: (fuente) => new Map(datos.uris).get(fuente.ref) } : {}),
  });
  let zotero = null;
  if (datos.preferenciasZotero) {
    const codigos = new Map([...r.citas].map(([numero, cita]) => [String(numero), cita.codigo]));
    if (r.bibliografia) codigos.set('BIB', r.bibliografia.codigo);
    zotero = { preferencias: datos.preferenciasZotero, codigos };
  } else if (datos.mendeley) {
    zotero = { mendeley: {
      citas: mendeleyCampos.datosDeCitas(r.citas, porClave, { comoCsl: csl.comoCsl, perfil: datos.mendeley.profileId }),
      estilo: mendeleyCampos.estiloDe(r.norma.id),
    } };
  }
  return documento.armar({
    ...datos.opciones,
    capitulos: datos.capitulos.map((capitulo, i) => ({ ...capitulo, texto: r.textos[i] })),
    citas: r.citas, referencias: r.bibliografia ?? [], zotero,
    fuentes: [...r.usadas.values()], norma: r.norma.id,
  });
}

test('proyecto: worker y vía directa conservan todas las partes del pipeline anterior', async (t) => {
  const pool = crearPoolWord({ archivoWorker: path.join(__dirname, 'fixtures/word.worker-determinista.js'), workers: 2 });
  t.after(() => pool.cerrar());
  for (const norma of ['apa', 'ieee', 'chicago-notes-bibliography', 'nature']) {
    await t.test(norma, async () => {
      const datos = proyecto(norma);
      const anterior = await conEntropiaFija(() => proyectoAnterior(datos));
      const directo = await conEntropiaFija(() => armarDirecto('proyecto', datos));
      const worker = await pool.ejecutar('proyecto', structuredClone(datos));
      compararPartes(anterior, directo.buffer);
      compararPartes(directo.buffer, worker.buffer);
      const { buffer: _, ...metadatos } = directo;
      const { buffer: __, ...metadatosWorker } = worker;
      assert.deepEqual(metadatosWorker, metadatos);
      const xml = parte(worker.buffer, 'word/document.xml');
      assert.doesNotMatch(xml, /⟦/);
      if (norma === 'chicago-notes-bibliography') assert.match(parte(worker.buffer, 'word/footnotes.xml'), /Disentangling behavioral intention/);
      if (norma === 'ieee') assert.match(xml, /\[1\]/);
      if (norma === 'apa') assert.match(xml, /1985/);
    });
  }
});

test('Zotero y Mendeley: mismos campos, notas, referencias y propiedades en el worker', async (t) => {
  const pool = crearPoolWord({ archivoWorker: path.join(__dirname, 'fixtures/word.worker-determinista.js'), workers: 2 });
  t.after(() => pool.cerrar());
  for (const gestor of ['zotero', 'mendeley']) {
    for (const norma of ['apa', 'chicago-notes-bibliography']) {
      await t.test(`${gestor}: ${norma}`, async () => {
        const datos = proyecto(norma);
        if (gestor === 'zotero') {
          datos.preferenciasZotero = zoteroCampos.preferencias({ norma, idioma: 'es-ES' });
          datos.uris = datos.fuentes.map((f) => [f.ref, [`http://zotero.org/users/123/items/${f.ref}`]]);
        } else datos.mendeley = { profileId: 'perfil-1' };
        const anterior = await conEntropiaFija(() => proyectoAnterior(datos));
        const directo = await conEntropiaFija(() => armarDirecto('proyecto', datos));
        const worker = await pool.ejecutar('proyecto', datos);
        compararPartes(anterior, directo.buffer);
        compararPartes(directo.buffer, worker.buffer);
        const xml = parte(worker.buffer, norma === 'apa' ? 'word/document.xml' : 'word/footnotes.xml');
        assert.match(xml, gestor === 'zotero' ? /ADDIN ZOTERO_ITEM CSL_CITATION/ : /MENDELEY_CITATION_v3_/);
        if (gestor === 'zotero') assert.match(parte(worker.buffer, 'docProps/custom.xml'), /ZOTERO_PREF_1/);
        else assert.match(parte(worker.buffer, 'word/webextensions/webextension1.xml'), /MENDELEY_CITATIONS/);
      });
    }
  }
});

test('plantilla, página, figuras y comentarios cruzan como datos y conservan el Word', async (t) => {
  const pool = crearPoolWord({ archivoWorker: path.join(__dirname, 'fixtures/word.worker-determinista.js'), workers: 1 });
  t.after(() => pool.cerrar());
  const datos = proyecto();
  datos.capitulos[0].texto += '\n\n**Figura 1**\n*Distribución de la motivación*\n[Insertar aquí la Figura 1: histograma.png]\n*Nota.* Elaboración propia.\n\n[PENDIENTE — confirmar el año]';
  datos.opciones.estilos =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
  datos.opciones.pagina = { margen: { top: 1417, right: 1701, bottom: 1417, left: 2268, header: 709, footer: 709, gutter: 0 }, tamano: { width: 11906, height: 16838 } };
  datos.opciones.figuras = new Map([['histograma.png', PNG.sync.write(new PNG({ width: 20, height: 10 }))]]);
  const anterior = await conEntropiaFija(() => proyectoAnterior(datos));
  const directo = await conEntropiaFija(() => armarDirecto('proyecto', datos));
  const worker = await pool.ejecutar('proyecto', structuredClone(datos));
  compararPartes(anterior, directo.buffer);
  compararPartes(directo.buffer, worker.buffer);
  assert.match(parte(worker.buffer, 'word/document.xml'), /<w:drawing>/);
  assert.match(parte(worker.buffer, 'word/styles.xml'), /Arial/);
  assert.match(parte(worker.buffer, 'word/comments.xml'), /confirmar el año/);
});

test('Word subido: conserva el original, reescrituras, citas y división de párrafos', async (t) => {
  const pool = crearPoolWord({ archivoWorker: path.join(__dirname, 'fixtures/word.worker-determinista.js'), workers: 1 });
  t.after(() => pool.cerrar());
  const base = proyecto();
  const buffer = docx(['Cabe destacar que crece.', 'Otra idea.']);
  const casos = [
    { nombre: 'original sin citas', citados: {}, reescritos: {} },
    { nombre: 'solo reescritura', citados: {}, reescritos: { 1: { original: 'Cabe destacar que crece.', texto: 'Crece.' } } },
    { nombre: 'citado', citados: { 1: 'Cabe destacar que crece [AR11111111].', 2: 'Otra idea [AR22222222].' }, reescritos: {} },
    { nombre: 'reescrito y citado', citados: { 1: 'Crece [AR11111111].' }, reescritos: { 1: { original: 'Cabe destacar que crece.', texto: 'Crece.' } } },
    // citarEnSuTurno guarda conApartes(texto): [APARTE] solo permanece en reescritos.
    { nombre: 'dividido y citado', citados: { 1: 'Primera idea [AR11111111]. Segunda idea [FALTA FUENTE].', 2: 'Otra idea [AR22222222].' }, reescritos: { 1: { original: 'Cabe destacar que crece.', texto: 'Primera idea. [APARTE] Segunda idea.' } } },
  ];
  for (const caso of casos) await t.test(caso.nombre, async () => {
    const datos = { buffer, fuentes: base.fuentes, recursos: base.recursos, estiloCitas: 'apa', idiomaCitas: 'es-ES', citados: caso.citados, reescritos: caso.reescritos };
    const directo = await conEntropiaFija(() => armarDirecto('documento', datos));
    const worker = await pool.ejecutar('documento', structuredClone(datos));
    compararPartes(directo.buffer, worker.buffer);
    const { buffer: _, ...metadatos } = directo;
    const { buffer: __, ...metadatosWorker } = worker;
    assert.deepEqual(metadatosWorker, metadatos);
    if (caso.nombre === 'original sin citas') assert.ok(worker.buffer.equals(buffer));
    if (caso.nombre === 'solo reescritura') compararPartes(reescritura.reescribir(buffer, caso.reescritos).buffer, worker.buffer);
    if (caso.nombre === 'citado') {
      const anterior = subido.citar(buffer, { citados: caso.citados, norma: 'apa', idioma: 'es-ES', porClave: new Map(base.fuentes.map((f) => [f.ref, f])) });
      compararPartes(anterior.buffer, worker.buffer);
    }
    if (caso.nombre === 'dividido y citado') {
      assert.equal(worker.humanizados, 1);
      assert.equal(worker.citas, 2);
      assert.equal(worker.faltas, 1);
      assert.match(parte(worker.buffer, 'word/document.xml'), /Segunda idea/);
    }
  });
});

test('el respaldo APA y las fuentes perdidas conservan el Word cuando falla el estilo CSL', async (t) => {
  const pool = crearPoolWord({ archivoWorker: path.join(__dirname, 'fixtures/word.worker-determinista.js'), workers: 1 });
  t.after(() => pool.cerrar());
  const datos = proyecto('ieee', { recursos: { error: 'No se pudo leer el estilo CSL de prueba' } });
  datos.capitulos[0].texto += '\n\nUna fuente perdida [ARFFFFFFFF].';
  // El respaldo anterior llamaba a resolver/bibliografiaConCursivas directamente.
  const usadas = new Map();
  const porClave = new Map(datos.fuentes.map((f) => [f.ref, f]));
  const capitulos = datos.capitulos.map((capitulo) => {
    const r = citas.resolver(capitulo.texto, porClave);
    for (const [clave, fuente] of r.usadas) usadas.set(clave, fuente);
    return { ...capitulo, texto: r.texto };
  });
  const anterior = await conEntropiaFija(() => documento.armar({
    ...datos.opciones, capitulos, referencias: citas.bibliografiaConCursivas([...usadas.values()]),
    fuentes: [...usadas.values()], norma: 'apa',
  }));
  const directo = await conEntropiaFija(() => armarDirecto('proyecto', datos));
  const worker = await pool.ejecutar('proyecto', datos);
  compararPartes(anterior, directo.buffer);
  compararPartes(directo.buffer, worker.buffer);
  assert.equal(worker.norma, 'apa');
  assert.equal(worker.usadas, 2);
  assert.deepEqual(worker.perdidas, ['ARFFFFFFFF']);
  assert.equal(worker.normaError.message, datos.recursos.error);
  assert.match(parte(worker.buffer, 'word/document.xml'), /CITA SIN LOCALIZAR/);
});

test('400 citas y 60 fuentes: el retraso máximo del event loop con worker es menor de 200 ms', { timeout: 120_000 }, async (t) => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/word.eventloop.js')], { timeout: 110_000, maxBuffer: 1024 * 1024 });
  assert.equal(stderr, '');
  const r = JSON.parse(stdout);
  t.diagnostic(`400 citas / ${r.fuentes} fuentes: directo ${r.antes.retrasoMaximoMs.toFixed(1)} ms; worker ${r.despues.retrasoMaximoMs.toFixed(1)} ms de retraso máximo; duración directa ${r.antes.duracionMs.toFixed(1)} ms, worker ${r.despues.duracionMs.toFixed(1)} ms.`);
  assert.equal(r.citas, 400);
  assert.equal(r.fuentes, 60);
  assert.equal(r.despues.fuentes, 60, 'se procesaron las 60 fuentes');
  assert.ok(r.despues.bytes > 10_000, 'se construyó y empaquetó el documento completo');
  assert.ok(r.despues.muestrasDurante >= 4, 'el intervalo se ejecutó durante el trabajo');
  assert.ok(r.despues.retrasoMaximoMs < 200, `retraso máximo ${r.despues.retrasoMaximoMs} ms`);
});
