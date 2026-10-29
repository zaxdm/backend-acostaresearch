'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const zenodo = require('../src/modules/externas/zenodo');
const hal = require('../src/modules/externas/hal');
const openaire = require('../src/modules/externas/openaire');

/**
 * Zenodo, HAL y OpenAIRE: qué URL piden (búsqueda, página, años), cómo se lee
 * un resultado y que una base caída no tumba la búsqueda. Fetch simulado.
 */

function fetchFalso(t, respuesta) {
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    pedidas.push(new URL(url));
    if (respuesta === null) return { ok: false, status: 503, text: async () => 'pausa' };
    if (respuesta === 'red') throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => respuesta };
  });
  return pedidas;
}

const CONSULTA = '("inteligencia artificial") AND ("educación")';

// ---------------------------------------------------------------- Zenodo

const registroZenodo = {
  id: 8280959,
  doi: '10.5281/zenodo.8280959',
  links: { self_html: 'https://zenodo.org/records/8280959' },
  files: [{ key: 'articulo.pdf', links: { self: 'https://zenodo.org/api/records/8280959/files/articulo.pdf/content' } }],
  metadata: {
    title: 'La IA en la <i>educación</i>',
    publication_date: '2023-08-25',
    description: '<p>Un resumen.</p>',
    access_right: 'open',
    creators: [{ name: 'Tecocha Portocarrero, Rosa Isabel' }, { name: 'Lampou, Rania' }],
    language: 'spa',
    resource_type: { type: 'publication', subtype: 'dissertation' },
    journal: { title: 'Revista X', volume: '4', pages: '20' },
  },
};

test('Zenodo: pide solo publicaciones, con la consulta, la página y los años', async (t) => {
  const pedidas = fetchFalso(t, { hits: { hits: [registroZenodo], total: 2618 } });
  const r = await zenodo.buscar({ consulta: CONSULTA, palabras: 'x', pagina: 3, porPagina: 10, desde: 2020, hasta: 2024 });

  assert.equal(r.caida, false);
  assert.equal(r.total, 2618);
  const url = pedidas[0];
  assert.equal(url.origin + url.pathname, 'https://zenodo.org/api/records');
  assert.equal(url.searchParams.get('type'), 'publication');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('size'), '10');
  assert.equal(url.searchParams.get('q'), `(${CONSULTA}) AND publication_date:[2020-01-01 TO 2024-12-31]`);
});

test('Zenodo: sin consulta exige todas las palabras (Zenodo las uniría con OR)', async (t) => {
  const pedidas = fetchFalso(t, { hits: { hits: [], total: 0 } });
  await zenodo.buscar({ palabras: 'inteligencia artificial', desde: 2021 });
  assert.equal(pedidas[0].searchParams.get('q'), '(inteligencia AND artificial) AND publication_date:[2021-01-01 TO *]');
});

test('Zenodo: lee un registro (id, DOI, autores APA, tesis, PDF)', async (t) => {
  fetchFalso(t, { hits: { hits: [registroZenodo], total: 1 } });
  const [res] = (await zenodo.buscar({ consulta: CONSULTA })).resultados;
  assert.equal(res.id, '8280959');
  assert.equal(res.doi, '10.5281/zenodo.8280959');
  assert.equal(res.autores, 'Tecocha Portocarrero, R. I.; Lampou, R.');
  assert.equal(res.tipo, 'dissertation');
  assert.equal(res.anio, 2023);
  assert.equal(res.idioma, 'es');
  assert.equal(res.titulo, 'La IA en la educación');
  assert.equal(res.resumen, 'Un resumen.');
  assert.match(res.pdfLibre, /articulo\.pdf\/content$/);
});

test('Zenodo: caída o error de red → caida: true', async (t) => {
  fetchFalso(t, null);
  assert.deepEqual(await zenodo.buscar({ consulta: CONSULTA }), { resultados: [], total: 0, caida: true });
  t.mock.restoreAll();
  fetchFalso(t, 'red');
  assert.equal((await zenodo.buscar({ consulta: CONSULTA })).caida, true);
});

test('Zenodo: porIds valida cada id y vuelve a pedir la ficha', async (t) => {
  const pedidas = fetchFalso(t, registroZenodo);
  const fichas = await zenodo.porIds(['8280959', '../admin', '1 OR 1', '8280959']);
  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0].pathname, '/api/records/8280959');
  assert.equal(fichas[0].itemType, 'thesis');
  assert.equal(fichas[0].volume, '4');
  assert.equal(fichas[0].authors, 'Tecocha Portocarrero, R. I.; Lampou, R.');
});

// ---------------------------------------------------------------- HAL

const docHal = {
  halId_s: 'tel-00993425',
  title_s: ['Inteligencia artificial y educación'],
  authLastName_s: ['Béreau'],
  authFirstName_s: ['Laurie Anne'],
  authFullName_s: ['Laurie Anne Béreau'],
  producedDateY_i: 2014,
  doiId_s: '10.1234/abc',
  authorityInstitution_s: ['Université de Strasbourg'],
  abstract_s: ['Resumen de la tesis.'],
  fileMain_s: 'https://theses.hal.science/tel-00993425/document',
  uri_s: 'https://theses.hal.science/tel-00993425v1',
  docType_s: 'THESE',
  language_s: ['es'],
};

test('HAL: pide con la consulta, la página (start), los años y solo tipos citables', async (t) => {
  const pedidas = fetchFalso(t, { response: { numFound: 757, docs: [docHal] } });
  const r = await hal.buscar({ consulta: CONSULTA, pagina: 2, porPagina: 5, desde: 2020, hasta: 2024 });

  assert.equal(r.caida, false);
  assert.equal(r.total, 757);
  const url = pedidas[0];
  assert.equal(url.origin + url.pathname, 'https://api.archives-ouvertes.fr/search/');
  assert.equal(url.searchParams.get('q'), CONSULTA);
  assert.equal(url.searchParams.get('wt'), 'json');
  assert.equal(url.searchParams.get('rows'), '5');
  assert.equal(url.searchParams.get('start'), '5');
  const fq = url.searchParams.getAll('fq');
  assert.ok(fq.includes('producedDateY_i:[2020 TO 2024]'));
  assert.ok(fq.some((f) => f.startsWith('docType_s:(') && f.includes('THESE')));
  assert.match(url.searchParams.get('fl'), /halId_s/);
});

test('HAL: lee un documento (id, DOI, autores APA, THESE → dissertation)', async (t) => {
  fetchFalso(t, { response: { numFound: 1, docs: [docHal] } });
  const [res] = (await hal.buscar({ palabras: 'ia educación' })).resultados;
  assert.equal(res.id, 'tel-00993425');
  assert.equal(res.doi, '10.1234/abc');
  assert.equal(res.autores, 'Béreau, L. A.');
  assert.equal(res.tipo, 'dissertation');
  assert.equal(res.revista, 'Université de Strasbourg');
  assert.equal(res.pdfLibre, 'https://theses.hal.science/tel-00993425/document');
});

test('HAL: caída → caida: true', async (t) => {
  fetchFalso(t, null);
  assert.equal((await hal.buscar({ consulta: CONSULTA })).caida, true);
});

test('HAL: porIds valida los ids y los pide juntos por halId_s', async (t) => {
  const pedidas = fetchFalso(t, { response: { numFound: 1, docs: [docHal] } });
  const fichas = await hal.porIds(['tel-00993425v1', 'hal-1) OR (*:*', 'x']);
  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0].searchParams.get('q'), 'halId_s:("tel-00993425")');
  assert.equal(fichas.length, 1);
  assert.equal(fichas[0].itemType, 'thesis');
  assert.deepEqual(await hal.porIds(['no vale']), []);
});

// ---------------------------------------------------------------- OpenAIRE

const productoOpenaire = {
  id: 'doi_dedup___::c7f117c43a0c7051aef9069f115f00cd',
  mainTitle: 'Artificial intelligence leads the reform',
  authors: [
    { fullName: 'Yanan Zhao', name: 'Yanan', surname: 'Zhao', rank: 2 },
    { fullName: 'Jianjing Qu', name: 'Jianjing', surname: 'Qu', rank: 1 },
  ],
  publicationDate: '2022-05-01',
  descriptions: ['<jats:p>Resumen.</jats:p>'],
  language: { code: 'spa' },
  container: { name: 'Systems Research', vol: '39', sp: '581', ep: '588' },
  pids: [{ scheme: 'doi', value: '10.1002/sres.2864' }],
  bestAccessRight: { label: 'OPEN' },
  indicators: { citationImpact: { citationCount: 69.0 } },
  instances: [
    { type: 'Article', urls: ['https://doi.org/10.1002/sres.2864'] },
    { type: 'Doctoral thesis', urls: ['https://repositorio.uni.es/bitstream/1/tesis.pdf'] },
  ],
};

test('OpenAIRE: pide publicaciones con la consulta, la página y las fechas', async (t) => {
  const pedidas = fetchFalso(t, { header: { numFound: 32299 }, results: [productoOpenaire] });
  const r = await openaire.buscar({ consulta: CONSULTA, pagina: 2, porPagina: 5, desde: 2020, hasta: 2024 });

  assert.equal(r.caida, false);
  assert.equal(r.total, 32299);
  const url = pedidas[0];
  assert.equal(url.origin + url.pathname, 'https://api.openaire.eu/graph/v1/researchProducts');
  assert.equal(url.searchParams.get('search'), CONSULTA);
  assert.equal(url.searchParams.get('type'), 'publication');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('pageSize'), '5');
  assert.equal(url.searchParams.get('fromPublicationDate'), '2020-01-01');
  assert.equal(url.searchParams.get('toPublicationDate'), '2024-12-31');
});

test('OpenAIRE: lee un producto (id, DOI, autores en orden, tesis, PDF, citas)', async (t) => {
  fetchFalso(t, { header: { numFound: 1 }, results: [productoOpenaire] });
  const [res] = (await openaire.buscar({ palabras: 'ia' })).resultados;
  assert.equal(res.id, 'doi_dedup___::c7f117c43a0c7051aef9069f115f00cd');
  assert.equal(res.doi, '10.1002/sres.2864');
  assert.equal(res.autores, 'Qu, J.; Zhao, Y.');
  assert.equal(res.tipo, 'dissertation');
  assert.equal(res.citas, 69);
  assert.equal(res.idioma, 'es');
  assert.equal(res.resumen, 'Resumen.');
  assert.equal(res.pdfLibre, 'https://repositorio.uni.es/bitstream/1/tesis.pdf');
});

test('OpenAIRE: caída → caida: true', async (t) => {
  fetchFalso(t, null);
  assert.equal((await openaire.buscar({ consulta: CONSULTA })).caida, true);
});

test('OpenAIRE: porIds valida los «::» y pide todos con id repetido', async (t) => {
  const pedidas = fetchFalso(t, { header: { numFound: 1 }, results: [productoOpenaire] });
  const fichas = await openaire.porIds([
    'doi_dedup___::c7f117c43a0c7051aef9069f115f00cd',
    'doi_dedup___::c7f117c43a0c7051aef9069f115f00cd&x=1',
    '../../admin',
  ]);
  assert.equal(pedidas.length, 1);
  assert.deepEqual(pedidas[0].searchParams.getAll('id'), ['doi_dedup___::c7f117c43a0c7051aef9069f115f00cd']);
  assert.match(pedidas[0].search, /id=doi_dedup___%3A%3Ac7f1/);
  assert.equal(fichas[0].pages, '581-588');
  assert.equal(fichas[0].itemType, 'thesis');
  assert.deepEqual(await openaire.porIds(['x::y']), []);
});

test('las tres cumplen la forma del contrato', () => {
  for (const b of [zenodo, hal, openaire]) {
    assert.match(b.clave, /^[a-z]+$/);
    assert.equal(typeof b.nombre, 'string');
    assert.equal(typeof b.detalle, 'string');
    assert.equal(b.activa(), true);
  }
});
