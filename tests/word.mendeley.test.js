'use strict';

/**
 * El Word con las citas de Mendeley Cite (ver `project.mendeley-campos`).
 *
 * Se arma el .docx de verdad, como en `word.norma.test.js`, y se lee su XML:
 * cada cita es un control con la etiqueta «MENDELEY_CITATION_v3_…», la
 * bibliografía un control «MENDELEY_BIBLIOGRAPHY» alrededor de sus párrafos, y
 * el paquete trae la parte del complemento con la lista de citas y la norma.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const csl = require('../src/modules/projects/project.csl');
const documento = require('../src/modules/projects/project.docx');
const mendeleyCampos = require('../src/modules/projects/project.mendeley-campos');

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
    // Vino del Mendeley del tesista: la cita apunta a SU documento.
    sourceRef: 'mendeley:perfil-1:doc-abc',
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

async function armarCon(norma) {
  const capitulos = [
    { titulo: 'Capítulo I', texto: 'Uno [AR11111111].\n\n[AR22222222:n] proponen seis fases.' },
  ];
  const r = csl.renderizar({ norma, idioma: 'es-ES', porClave, capitulos });

  return documento.armar({
    tema: 'Un tema',
    carrera: 'Una carrera',
    universidad: 'Una universidad',
    nombre: 'Alguien',
    capitulos: capitulos.map((c, i) => ({ titulo: c.titulo, texto: r.textos[i] })),
    citas: r.citas,
    referencias: r.bibliografia,
    zotero: {
      mendeley: {
        citas: mendeleyCampos.datosDeCitas(r.citas, porClave, { comoCsl: csl.comoCsl, perfil: 'perfil-1' }),
        estilo: mendeleyCampos.estiloDe(norma),
      },
    },
  });
}

const parte = (buffer, nombre) => {
  const entrada = new AdmZip(buffer).getEntry(nombre);
  return entrada ? entrada.getData().toString('utf8') : null;
};

const datosDe = (etiqueta) => JSON.parse(Buffer.from(etiqueta, 'base64').toString('utf8'));

test('con Mendeley, cada cita es un control de Mendeley Cite con sus datos dentro', async () => {
  const buffer = await armarCon('apa');
  const doc = parte(buffer, 'word/document.xml');

  const etiquetas = [...doc.matchAll(/<w:tag w:val="MENDELEY_CITATION_v3_([A-Za-z0-9+/=]+)"\/>/g)].map((m) => m[1]);
  assert.equal(etiquetas.length, 2);
  assert.ok(!doc.includes('⟦Z'), 'no queda ninguna marca sin coser');
  assert.ok(!doc.includes('ZOTERO'), 'no se mezcla con campos de Zotero');

  const [primera, segunda] = etiquetas.map(datosDe);
  assert.equal(primera.citationItems[0].id, 'doc-abc', 'la fuente de su Mendeley apunta a su documento');
  assert.equal(primera.citationItems[0].itemData.title, 'Disentangling behavioral intention and behavioral expectation');
  assert.equal(primera.citationItems[0].itemData.id, 'doc-abc');
  assert.match(segunda.citationItems[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(segunda.citationItems[0]['suppress-author'] === undefined || segunda.citationItems[0]['suppress-author'] === true);
  assert.equal(primera.manualOverride.isManuallyOverridden, false);
  assert.ok(primera.manualOverride.citeprocText.includes('1985'));

  // El texto visible de la cita sigue dentro del control.
  const control = doc.slice(doc.indexOf('MENDELEY_CITATION_v3_'), doc.indexOf('</w:sdt>', doc.indexOf('MENDELEY_CITATION_v3_')));
  assert.ok(control.includes('1985'));

  const aperturas = (doc.match(/<w:sdt>/g) || []).length;
  const cierres = (doc.match(/<\/w:sdt>/g) || []).length;
  assert.equal(aperturas, cierres, 'cada control que se abre se cierra');
});

test('la bibliografía es un control de bloque que envuelve todas sus entradas', async () => {
  const doc = parte(await armarCon('apa'), 'word/document.xml');

  const inicio = doc.indexOf('<w:tag w:val="MENDELEY_BIBLIOGRAPHY"/>');
  assert.ok(inicio > -1);
  const fin = doc.indexOf('</w:sdtContent></w:sdt>', inicio);
  const bloque = doc.slice(inicio, fin);
  assert.ok(bloque.includes('Braun'));
  assert.ok(bloque.includes('Warshaw'));
  // El control empieza justo antes de un párrafo, no dentro de él.
  assert.ok(doc.slice(inicio).match(/^<w:tag[^>]+\/><w:id w:val="-?\d+"\/><\/w:sdtPr><w:sdtContent><w:p[ >]/));
});

test('el paquete trae la parte del complemento con la lista de citas y la norma', async () => {
  const buffer = await armarCon('apa');

  const extension = parte(buffer, 'word/webextensions/webextension1.xml');
  assert.ok(extension.includes('wa104382081'));
  assert.ok(extension.includes('name="MENDELEY_CITATIONS"'));
  assert.ok(extension.includes('https://www.zotero.org/styles/apa'));
  assert.ok(parte(buffer, 'word/webextensions/taskpanes.xml'));
  assert.ok(parte(buffer, '[Content_Types].xml').includes('/word/webextensions/webextension1.xml'));
  assert.ok(parte(buffer, '_rels/.rels').includes('webextensiontaskpanes'));

  const lista = JSON.parse(
    extension
      .match(/name="MENDELEY_CITATIONS" value="([^"]*)"/)[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  );
  assert.equal(lista.length, 2);
  assert.ok(lista[0].citationTag.startsWith('MENDELEY_CITATION_v3_'));
});

test('Chicago notas con Mendeley: el control va dentro de la nota al pie', async () => {
  const buffer = await armarCon('chicago-notes-bibliography');

  assert.ok(parte(buffer, 'word/footnotes.xml').includes('MENDELEY_CITATION_v3_'));
  assert.ok(parte(buffer, 'word/webextensions/webextension1.xml').includes('&quot;format&quot;:&quot;note&quot;'));
});

test('la misma fuente da siempre el mismo identificador', () => {
  const a = mendeleyCampos.idDeMendeley({ ref: 'AR22222222' });
  const b = mendeleyCampos.idDeMendeley({ ref: 'AR22222222' });
  const otra = mendeleyCampos.idDeMendeley({ ref: 'AR33333333' });
  assert.equal(a, b);
  assert.notEqual(a, otra);
  // Una fuente de OTRO perfil de Mendeley no se toma como suya.
  assert.notEqual(mendeleyCampos.idDeMendeley({ ref: 'X', sourceRef: 'mendeley:otro:doc' }, { perfil: 'perfil-1' }), 'doc');
});
