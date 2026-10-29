'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const doaj = require('../src/modules/externas/doaj');
const crossref = require('../src/modules/externas/crossref');
const core = require('../src/modules/externas/core');

/**
 * DOAJ, Crossref y CORE como bases del buscador del panel. Fetch simulado:
 * se comprueba qué URL se pide y cómo se traduce la respuesta al contrato.
 */

function fetchFalso(t, respuesta) {
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url, opciones = {}) => {
    pedidas.push({ url: new URL(url), headers: opciones.headers ?? {} });
    if (respuesta === null) return { ok: false, status: 503, text: async () => 'caída', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => respuesta, text: async () => JSON.stringify(respuesta) };
  });
  return pedidas;
}

// ---------------------------------------------------------------- DOAJ

const ID_DOAJ = '00348d61600f4aa6801d6aa29027fe10';
const registroDoaj = {
  id: ID_DOAJ,
  bibjson: {
    title: 'Inteligencia artificial en la <i>escuela</i>',
    year: '2022',
    abstract: '\nUn resumen.\r\n',
    start_page: '10',
    end_page: '25',
    identifier: [{ type: 'doi', id: 'https://doi.org/10.1234/ABC.5' }, { type: 'eissn', id: '1234-5678' }],
    journal: { title: 'Revista X', volume: '7', number: '2', language: ['ES'] },
    author: [{ name: 'Rosa Isabel Tecocha Portocarrero' }],
    link: [
      { type: 'fulltext', content_type: 'HTML', url: 'https://revista.x/7' },
      { type: 'fulltext', content_type: 'PDF', url: 'https://revista.x/7.pdf' },
    ],
  },
};

test('DOAJ: consulta booleana en la ruta, con años, página y tamaño', async (t) => {
  const pedidas = fetchFalso(t, { total: 4306, results: [registroDoaj] });
  const { resultados, total, caida } = await doaj.buscar({
    consulta: '("ia" OR "machine learning") AND ("educación")',
    palabras: 'ia machine learning educación',
    pagina: 3,
    porPagina: 25,
    desde: 2020,
    hasta: 2022,
  });

  assert.equal(caida, false);
  assert.equal(total, 1000, 'se anuncia como mucho el tope de DOAJ');
  const { url } = pedidas[0];
  assert.equal(url.origin + url.pathname.split('/search/')[0], 'https://doaj.org/api/v4');
  const consulta = decodeURIComponent(url.pathname.split('/search/articles/')[1]);
  assert.equal(consulta, '(("ia" OR "machine learning") AND ("educación")) AND bibjson.year:[2020 TO 2022]');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('pageSize'), '25');

  const [r] = resultados;
  assert.equal(r.id, ID_DOAJ);
  assert.equal(r.doi, '10.1234/ABC.5');
  assert.equal(r.titulo, 'Inteligencia artificial en la escuela');
  assert.equal(r.autores, 'Tecocha Portocarrero, R.');
  assert.equal(r.anio, 2022);
  assert.equal(r.idioma, 'es');
  assert.equal(r.enlace, 'https://revista.x/7');
  assert.equal(r.pdfLibre, 'https://revista.x/7.pdf');
  assert.equal(r.resumen, 'Un resumen.');
  assert.equal(r.tipo, 'article');
});

test('DOAJ: un solo año abierto usa «*» y más allá del registro 1000 no se pide', async (t) => {
  const pedidas = fetchFalso(t, { total: 5, results: [] });
  await doaj.buscar({ palabras: 'tesis', desde: 2021 });
  assert.match(decodeURIComponent(pedidas[0].url.pathname), /\(tesis\) AND bibjson\.year:\[2021 TO \*\]$/);

  const lejos = await doaj.buscar({ palabras: 'tesis', pagina: 41, porPagina: 25 });
  assert.equal(pedidas.length, 1);
  assert.equal(lejos.caida, false);
  assert.deepEqual(lejos.resultados, []);
});

test('DOAJ: si falla, caída', async (t) => {
  fetchFalso(t, null);
  assert.deepEqual(await doaj.buscar({ palabras: 'x' }), { resultados: [], total: 0, caida: true });
});

test('DOAJ: porIds valida los id y los pide en una sola búsqueda', async (t) => {
  const pedidas = fetchFalso(t, { total: 1, results: [registroDoaj] });
  const fichas = await doaj.porIds([ID_DOAJ, 'no-es-un-id', '../../admin', ID_DOAJ]);
  assert.equal(pedidas.length, 1);
  assert.equal(decodeURIComponent(pedidas[0].url.pathname.split('/search/articles/')[1]), `id:(${ID_DOAJ})`);
  assert.deepEqual(fichas[0], {
    id: ID_DOAJ,
    doi: '10.1234/ABC.5',
    title: 'Inteligencia artificial en la escuela',
    authors: 'Tecocha Portocarrero, R.',
    year: 2022,
    source: 'Revista X',
    volume: '7',
    issue: '2',
    pages: '10-25',
    url: 'https://revista.x/7',
    abstract: 'Un resumen.',
    itemType: 'journalArticle',
  });

  const nada = await doaj.porIds(['zzz']);
  assert.deepEqual(nada, []);
  assert.equal(pedidas.length, 1, 'sin ids válidos no se pide nada');
});

// ---------------------------------------------------------------- Crossref

const obraCrossref = {
  DOI: '10.5555/Tesis.1',
  URL: 'https://doi.org/10.5555/tesis.1',
  type: 'dissertation',
  title: ['Clima <i>organizacional</i>'],
  author: [{ family: 'Hernández Sampieri', given: 'Roberto Carlos' }, { name: 'Consorcio X' }],
  issued: { 'date-parts': [[2021, 5]] },
  'container-title': ['Universidad Nacional'],
  'is-referenced-by-count': 12,
  abstract: '<jats:p>Resumen <jats:italic>en</jats:italic> JATS.</jats:p>',
  page: '45 – 62',
  volume: '3',
};

test('Crossref: palabras sueltas, rows/offset, años, select y mailto', async (t) => {
  const pedidas = fetchFalso(t, { message: { 'total-results': 321, items: [obraCrossref] } });
  const { resultados, total, caida } = await crossref.buscar({
    consulta: '("clima") AND ("desempeño")',
    palabras: 'clima desempeño',
    pagina: 2,
    porPagina: 25,
    desde: 2019,
    hasta: 2023,
  });

  assert.equal(caida, false);
  assert.equal(total, 321);
  const { url } = pedidas[0];
  assert.equal(url.origin + url.pathname, 'https://api.crossref.org/works');
  assert.equal(url.searchParams.get('query.bibliographic'), 'clima desempeño');
  assert.equal(url.searchParams.get('rows'), '25');
  assert.equal(url.searchParams.get('offset'), '25');
  assert.equal(url.searchParams.get('filter'), 'from-pub-date:2019,until-pub-date:2023');
  assert.ok(url.searchParams.get('mailto'));
  assert.match(url.searchParams.get('select'), /is-referenced-by-count/);

  const [r] = resultados;
  assert.equal(r.id, '10.5555/Tesis.1');
  assert.equal(r.doi, '10.5555/Tesis.1');
  assert.equal(r.titulo, 'Clima organizacional');
  assert.equal(r.autores, 'Hernández Sampieri, R. C.; Consorcio X');
  assert.equal(r.anio, 2021);
  assert.equal(r.citas, 12);
  assert.equal(r.resumen, 'Resumen en JATS.');
  assert.equal(r.tipo, 'dissertation');
  assert.equal(r.pdfLibre, null);
});

test('Crossref: sin palabras quita los operadores de la booleana; sin años no hay filtro', async (t) => {
  const pedidas = fetchFalso(t, { message: { 'total-results': 0, items: [] } });
  await crossref.buscar({ consulta: '("clima laboral") AND ("Perú")' });
  assert.equal(pedidas[0].url.searchParams.get('query.bibliographic'), 'clima laboral Perú');
  assert.equal(pedidas[0].url.searchParams.get('filter'), null);
});

test('Crossref: si falla, caída', async (t) => {
  fetchFalso(t, null);
  assert.equal((await crossref.buscar({ palabras: 'x' })).caida, true);
});

test('Crossref: porIds filtra por DOI en una petición y da fichas de tesis', async (t) => {
  const pedidas = fetchFalso(t, { message: { items: [obraCrossref] } });
  const fichas = await crossref.porIds(['https://doi.org/10.5555/tesis.1', 'no es doi', '10.1/x y']);
  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0].url.searchParams.get('filter'), 'doi:10.5555/tesis.1');
  assert.equal(fichas.length, 1);
  assert.equal(fichas[0].itemType, 'thesis');
  assert.equal(fichas[0].pages, '45-62');
  assert.equal(fichas[0].source, 'Universidad Nacional');
});

// ---------------------------------------------------------------- CORE

const obraCore = {
  id: 154565417,
  doi: '10.7777/core.9',
  title: 'Tesis de maestría',
  authors: [{ name: 'Pérez García, Ana María' }, { name: 'Juan Quispe' }, { name: 'National Security Commission (U.S.)' }],
  yearPublished: 2020,
  documentType: 'thesis',
  citationCount: 4,
  abstract: 'Resumen &amp; más',
  downloadUrl: 'https://core.ac.uk/download/1.pdf',
  publisher: 'Universidad X',
  journals: [],
  language: { code: 'ES', name: 'Spanish' },
  links: [{ type: 'display', url: 'https://core.ac.uk/works/154565417' }],
};

test('CORE: sin clave está apagada y no pide nada', async (t) => {
  const antes = process.env.CORE_API_KEY;
  delete process.env.CORE_API_KEY;
  t.after(() => {
    if (antes !== undefined) process.env.CORE_API_KEY = antes;
  });
  const pedidas = fetchFalso(t, { totalHits: 1, results: [obraCore] });

  assert.equal(core.activa(), false);
  assert.deepEqual(await core.buscar({ palabras: 'x' }), { resultados: [], total: 0, caida: true });
  assert.deepEqual(await core.porIds(['154565417']), []);
  assert.equal(pedidas.length, 0);
});

test('CORE: con clave, Bearer, q con años, limit/offset y mapeo', async (t) => {
  const antes = process.env.CORE_API_KEY;
  process.env.CORE_API_KEY = 'clave-de-prueba';
  t.after(() => {
    if (antes === undefined) delete process.env.CORE_API_KEY;
    else process.env.CORE_API_KEY = antes;
  });
  const pedidas = fetchFalso(t, { totalHits: 2082602, results: [obraCore] });

  assert.equal(core.activa(), true);
  const { resultados, total, caida } = await core.buscar({
    consulta: '("ia") AND ("educación")',
    pagina: 3,
    porPagina: 25,
    desde: 2020,
    hasta: 2023,
  });
  assert.equal(caida, false);
  assert.equal(total, 2082602);
  const { url, headers } = pedidas[0];
  assert.equal(url.origin + url.pathname, 'https://api.core.ac.uk/v3/search/works/');
  assert.equal(url.searchParams.get('q'), '(("ia") AND ("educación")) AND yearPublished>=2020 AND yearPublished<=2023');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(headers.Authorization, 'Bearer clave-de-prueba');

  const [r] = resultados;
  assert.equal(r.id, '154565417');
  assert.equal(r.doi, '10.7777/core.9');
  assert.equal(r.autores, 'Pérez García, A. M.; Quispe, J.; National Security Commission (U.S.)');
  assert.equal(r.tipo, 'dissertation');
  assert.equal(r.pdfLibre, 'https://core.ac.uk/download/1.pdf');
  assert.equal(r.citas, 4);
  assert.equal(r.resumen, 'Resumen & más');
  assert.equal(r.idioma, 'es');
  assert.equal(r.revista, 'Universidad X');

  const fichas = await core.porIds(['154565417', '1; DROP', 'abc']);
  assert.equal(pedidas.length, 2);
  assert.equal(pedidas[1].url.searchParams.get('q'), 'id:154565417');
  assert.equal(fichas[0].itemType, 'thesis');
  assert.equal(fichas[0].url, 'https://core.ac.uk/works/154565417');
});

test('CORE: si falla, caída', async (t) => {
  const antes = process.env.CORE_API_KEY;
  process.env.CORE_API_KEY = 'clave-de-prueba';
  t.after(() => {
    if (antes === undefined) delete process.env.CORE_API_KEY;
    else process.env.CORE_API_KEY = antes;
  });
  fetchFalso(t, null);
  assert.equal((await core.buscar({ palabras: 'x' })).caida, true);
});
