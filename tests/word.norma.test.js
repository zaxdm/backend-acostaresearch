'use strict';

/**
 * El Word en la norma del proyecto: que las citas lleguen al documento.
 *
 * `citas.norma.test.js` comprueba lo que sale del motor; esto comprueba que el
 * Word lo pone donde toca. En el texto en las normas de autor-fecha y
 * numéricas, en notas al pie en las de notas, y envuelto en campos de Zotero
 * solo cuando el tesista lo conectó. Se abre el .docx de verdad y se lee su XML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const csl = require('../src/modules/projects/project.csl');
const documento = require('../src/modules/projects/project.docx');
const zoteroCampos = require('../src/modules/projects/project.zotero-campos');

const FUENTES = [
  {
    ref: 'AR11111111',
    itemType: 'journalArticle',
    title: 'Disentangling behavioral intention and behavioral expectation',
    authors: 'Warshaw, P. R.; Davis, F. D.',
    year: 1985,
    source: 'Journal of Experimental Social Psychology',
    volume: '21',
    issue: '3',
    pages: '213-228',
  },
  {
    ref: 'AR22222222',
    itemType: 'journalArticle',
    title: 'Using thematic analysis in psychology',
    authors: 'Braun, V.; Clarke, V.',
    year: 2006,
    source: 'Qualitative Research in Psychology',
    volume: '3',
    issue: '2',
    pages: '77-101',
  },
];

const porClave = new Map(FUENTES.map((f) => [f.ref, f]));

async function armarCon(norma, { zotero = false } = {}) {
  const capitulos = [
    { titulo: 'Capítulo I', texto: 'Uno [AR11111111].\n\n[AR22222222:n] proponen seis fases.' },
  ];
  const r = csl.renderizar({ norma, idioma: 'es-ES', porClave, capitulos });

  const codigos = new Map([...r.citas].map(([n, c]) => [String(n), c.codigo]));
  codigos.set('BIB', r.bibliografia.codigo);

  return documento.armar({
    tema: 'Un tema',
    carrera: 'Una carrera',
    universidad: 'Una universidad',
    nombre: 'Alguien',
    capitulos: capitulos.map((c, i) => ({ titulo: c.titulo, texto: r.textos[i] })),
    citas: r.citas,
    referencias: r.bibliografia,
    zotero: zotero ? { preferencias: zoteroCampos.preferencias({ norma, idioma: 'es-ES' }), codigos } : null,
  });
}

const parte = (buffer, nombre) => {
  const entrada = new AdmZip(buffer).getEntry(nombre);
  return entrada ? entrada.getData().toString('utf8') : null;
};

test('IEEE: las citas numeradas y la narrativa están en el texto del Word', async () => {
  const doc = parte(await armarCon('ieee'), 'word/document.xml');

  assert.ok(doc.includes('[1]'));
  assert.ok(doc.includes('Braun y Clarke'));
  assert.ok(!doc.includes('⟦'), 'no queda ningún hueco sin cambiar');
  assert.ok(!doc.includes('ZOTERO'), 'sin Zotero conectado no hay campos');
});

test('Chicago notas: las citas van a notas al pie y la lista se llama Bibliografía', async () => {
  const buffer = await armarCon('chicago-notes-bibliography');
  const doc = parte(buffer, 'word/document.xml');
  const notas = parte(buffer, 'word/footnotes.xml');

  assert.ok(doc.includes('w:footnoteReference'));
  assert.ok(notas && notas.includes('Disentangling behavioral intention'));
  assert.ok(doc.includes('Bibliografía'));
});

test('Nature: el número de cita sale volado', async () => {
  const doc = parte(await armarCon('nature'), 'word/document.xml');
  assert.ok(doc.includes('w:vertAlign w:val="superscript"'));
});

test('con Zotero conectado, cada cita y la bibliografía son campos de Zotero', async () => {
  const buffer = await armarCon('apa', { zotero: true });
  const doc = parte(buffer, 'word/document.xml');

  assert.equal((doc.match(/ADDIN ZOTERO_ITEM CSL_CITATION/g) || []).length, 2);
  assert.ok(doc.includes('ADDIN ZOTERO_BIBL'));
  assert.ok(!doc.includes('⟦Z'), 'no queda ninguna marca sin coser');

  const aperturas = (doc.match(/w:fldCharType="begin"/g) || []).length;
  const cierres = (doc.match(/w:fldCharType="end"/g) || []).length;
  assert.equal(aperturas, cierres, 'cada campo que se abre se cierra');

  const propiedades = parte(buffer, 'docProps/custom.xml');
  assert.ok(propiedades.includes('ZOTERO_PREF_1'));
  assert.ok(propiedades.includes('http://www.zotero.org/styles/apa'));
});

test('Chicago notas con Zotero: el campo va dentro de la nota al pie', async () => {
  const buffer = await armarCon('chicago-notes-bibliography', { zotero: true });

  assert.ok(parte(buffer, 'word/footnotes.xml').includes('ADDIN ZOTERO_ITEM CSL_CITATION'));
  assert.ok(parte(buffer, 'docProps/custom.xml').includes('noteType'));
});

test('las preferencias se parten en trozos de 255, como las guarda el complemento', () => {
  const trozos = zoteroCampos.preferencias({ norma: 'chicago-shortened-notes-bibliography', idioma: 'es-MX' });

  assert.ok(trozos.length >= 2);
  assert.ok(trozos.every((t) => t.value.length <= 255));
  assert.equal(trozos[0].name, 'ZOTERO_PREF_1');
  assert.ok(trozos.map((t) => t.value).join('').includes('locale="es-MX"'));
});
