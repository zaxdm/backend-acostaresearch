'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pubmed = require('../src/modules/externas/pubmed');
const europepmc = require('../src/modules/externas/europepmc');
const eric = require('../src/modules/externas/eric');

/**
 * PubMed, Europe PMC y ERIC: qué URL piden, cómo queda un resultado y que una
 * base caída se dice caída. Con fetch simulado; la respuesta depende de la URL.
 */

function fetchFalso(t, responder) {
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    pedidas.push(u);
    const r = responder(u);
    if (r === null) return { ok: false, status: 503, text: async () => 'caída' };
    if (typeof r === 'string') return { ok: true, status: 200, text: async () => r, json: async () => JSON.parse(r) };
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
  });
  return pedidas;
}

const consulta = '("artificial intelligence") AND ("education")';

// ---------------------------------------------------------------- PubMed

const resumenPubmed = {
  result: {
    uids: ['42950240'],
    42950240: {
      uid: '42950240',
      pubdate: '2026 Oct 28',
      fulljournalname: 'JMIR medical education',
      authors: [{ name: 'Bantidos MG' }, { name: 'Dafli E' }, { name: 'WHO Study Group' }],
      title: 'Virtual patients &amp; AI.',
      volume: '12',
      issue: '',
      pages: 'e100839',
      lang: ['eng'],
      pubtype: ['Journal Article', 'Systematic Review'],
      articleids: [
        { idtype: 'pubmed', value: '42950240' },
        { idtype: 'doi', value: '10.2196/100839' },
      ],
      pmcrefcount: '4',
    },
  },
};

const xmlPubmed = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">42950240</PMID>
<Abstract><AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">Virtual <i>patients</i>.</AbstractText>
<AbstractText Label="METHODS">A trial.</AbstractText></Abstract></MedlineCitation></PubmedArticle></PubmedArticleSet>`;

function respuestaPubmed(u) {
  if (u.pathname.endsWith('esearch.fcgi')) return { esearchresult: { count: '49950', idlist: ['42950240'] } };
  if (u.pathname.endsWith('esummary.fcgi')) return resumenPubmed;
  if (u.pathname.endsWith('efetch.fcgi')) return xmlPubmed;
  return null;
}

test('PubMed: pide la consulta, la página y los años, y se identifica', async (t) => {
  const pedidas = fetchFalso(t, respuestaPubmed);
  const { resultados, total, caida } = await pubmed.buscar({ consulta, pagina: 3, porPagina: 10, desde: 2020, hasta: 2024 });

  assert.equal(caida, false);
  assert.equal(total, 49950);
  const busqueda = pedidas.find((u) => u.pathname.endsWith('esearch.fcgi'));
  assert.equal(busqueda.searchParams.get('term'), consulta);
  assert.equal(busqueda.searchParams.get('retmode'), 'json');
  assert.equal(busqueda.searchParams.get('retmax'), '10');
  assert.equal(busqueda.searchParams.get('retstart'), '20');
  assert.equal(busqueda.searchParams.get('datetype'), 'pdat');
  assert.equal(busqueda.searchParams.get('mindate'), '2020');
  assert.equal(busqueda.searchParams.get('maxdate'), '2024');
  assert.equal(busqueda.searchParams.get('tool'), 'acostaresearch');
  assert.ok(busqueda.searchParams.get('email'));
  const efetch = pedidas.find((u) => u.pathname.endsWith('efetch.fcgi'));
  assert.equal(efetch.searchParams.get('rettype'), 'abstract');
  assert.equal(efetch.searchParams.get('id'), '42950240');

  const r = resultados[0];
  assert.equal(r.id, '42950240');
  assert.equal(r.doi, '10.2196/100839');
  assert.equal(r.autores, 'Bantidos, M. G.; Dafli, E.; WHO Study Group');
  assert.equal(r.tipo, 'review');
  assert.equal(r.anio, 2026);
  assert.equal(r.titulo, 'Virtual patients & AI.');
  assert.equal(r.idioma, 'en');
  assert.equal(r.citas, 4);
  assert.equal(r.enlace, 'https://pubmed.ncbi.nlm.nih.gov/42950240/');
  assert.equal(r.resumen, 'BACKGROUND: Virtual patients. METHODS: A trial.');
});

test('PubMed: con la clave del .env la manda como api_key', async (t) => {
  t.after(() => delete process.env.NCBI_API_KEY);
  process.env.NCBI_API_KEY = 'clave-de-prueba';
  const pedidas = fetchFalso(t, respuestaPubmed);
  await pubmed.buscar({ consulta });
  assert.equal(pedidas[0].searchParams.get('api_key'), 'clave-de-prueba');
  assert.equal(pedidas[0].searchParams.has('datetype'), false);
});

test('PubMed: si no contesta, caída', async (t) => {
  fetchFalso(t, () => null);
  const r = await pubmed.buscar({ consulta });
  assert.equal(r.caida, true);
});

test('PubMed: porIds solo pide PMID de dígitos y devuelve fichas', async (t) => {
  const pedidas = fetchFalso(t, respuestaPubmed);
  const fichas = await pubmed.porIds(['42950240', '<script>', '42950240', '12a']);
  const esummary = pedidas.find((u) => u.pathname.endsWith('esummary.fcgi'));
  assert.equal(esummary.searchParams.get('id'), '42950240');
  assert.equal(fichas.length, 1);
  assert.equal(fichas[0].title, 'Virtual patients & AI.');
  assert.equal(fichas[0].source, 'JMIR medical education');
  assert.equal(fichas[0].volume, '12');
  assert.equal(fichas[0].issue, null);
  assert.equal(fichas[0].itemType, 'journalArticle');
  assert.match(fichas[0].abstract, /^BACKGROUND:/);

  assert.deepEqual(await pubmed.porIds(['nada', '1; DROP']), []);
});

// ---------------------------------------------------------------- Europe PMC

const registroEpmc = {
  id: '41797731',
  source: 'MED',
  doi: '10.3389/fnins.2024.1278640',
  title: 'From Mary Shelley to Netflix.',
  authorString: 'Gallar Martínez ÁC, De Lara González A.',
  authorList: {
    author: [
      { fullName: 'Gallar Martínez ÁC', lastName: 'Gallar Martínez', initials: 'ÁC' },
      { collectiveName: 'EBRAINS Consortium' },
    ],
  },
  journalInfo: { volume: '18', issue: '2', journal: { title: 'Frontiers in neuroscience' } },
  pubYear: '2024',
  pageInfo: '1278640',
  abstractText: '<h4>Intro</h4>Scientific knowledge.',
  language: 'eng',
  pubTypeList: { pubType: ['research-article', 'Journal Article'] },
  fullTextUrlList: {
    fullTextUrl: [
      { availabilityCode: 'S', documentStyle: 'pdf', url: 'https://cerrado.example/x.pdf' },
      { availabilityCode: 'OA', documentStyle: 'pdf', url: 'https://europepmc.org/articles/PMC12965704?pdf=render' },
    ],
  },
  citedByCount: 7,
};

test('Europe PMC: consulta con años y salto por cursor a la página pedida', async (t) => {
  const pedidas = fetchFalso(t, (u) =>
    u.searchParams.get('resultType') === 'idlist'
      ? { hitCount: 56306, nextCursorMark: 'CURSOR-P3' }
      : { hitCount: 56306, nextCursorMark: 'CURSOR-P4', resultList: { result: [registroEpmc] } },
  );
  const { resultados, total, caida } = await europepmc.buscar({ consulta, pagina: 3, porPagina: 5, desde: 2020, hasta: 2024 });

  assert.equal(caida, false);
  assert.equal(total, 56306);
  assert.equal(pedidas.length, 2);
  const [salto, pagina] = pedidas;
  assert.equal(salto.searchParams.get('pageSize'), '10');
  assert.equal(salto.searchParams.get('cursorMark'), '*');
  assert.equal(pagina.searchParams.get('query'), `(${consulta}) AND PUB_YEAR:[2020 TO 2024]`);
  assert.equal(pagina.searchParams.get('format'), 'json');
  assert.equal(pagina.searchParams.get('resultType'), 'core');
  assert.equal(pagina.searchParams.get('pageSize'), '5');
  assert.equal(pagina.searchParams.get('cursorMark'), 'CURSOR-P3');

  const r = resultados[0];
  assert.equal(r.id, 'MED-41797731');
  assert.equal(r.doi, '10.3389/fnins.2024.1278640');
  assert.equal(r.autores, 'Gallar Martínez, Á. C.; EBRAINS Consortium');
  assert.equal(r.tipo, 'article');
  assert.equal(r.citas, 7);
  assert.equal(r.pdfLibre, 'https://europepmc.org/articles/PMC12965704?pdf=render');
  assert.equal(r.resumen, 'Intro Scientific knowledge.');
  assert.equal(r.enlace, 'https://europepmc.org/article/MED/41797731');

  // La página siguiente ya tiene su cursor: una sola petición.
  pedidas.length = 0;
  await europepmc.buscar({ consulta, pagina: 4, porPagina: 5, desde: 2020, hasta: 2024 });
  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0].searchParams.get('cursorMark'), 'CURSOR-P4');
});

test('Europe PMC: si no contesta, caída', async (t) => {
  fetchFalso(t, () => null);
  assert.equal((await europepmc.buscar({ consulta })).caida, true);
});

test('Europe PMC: porIds valida fuente e id y pide por EXT_ID y SRC', async (t) => {
  const pedidas = fetchFalso(t, () => ({ hitCount: 1, resultList: { result: [registroEpmc] } }));
  const fichas = await europepmc.porIds(['MED-41797731', 'PPR:PPR1304948', 'XYZ-1', 'MED-1 OR 1', '41797731']);
  assert.equal(pedidas.length, 1);
  assert.equal(
    pedidas[0].searchParams.get('query'),
    '(EXT_ID:41797731 AND SRC:MED) OR (EXT_ID:PPR1304948 AND SRC:PPR)',
  );
  assert.equal(fichas.length, 1);
  assert.deepEqual(
    { id: fichas[0].id, volume: fichas[0].volume, issue: fichas[0].issue, pages: fichas[0].pages, itemType: fichas[0].itemType },
    { id: 'MED-41797731', volume: '18', issue: '2', pages: '1278640', itemType: 'journalArticle' },
  );
  assert.deepEqual(await europepmc.porIds(['<x>']), []);
});

test('Europe PMC: un preprint es preprint', async (t) => {
  fetchFalso(t, () => ({
    hitCount: 1,
    resultList: { result: [{ ...registroEpmc, id: 'PPR1', source: 'PPR', pubTypeList: { pubType: ['Preprint'] } }] },
  }));
  const { resultados } = await europepmc.buscar({ consulta });
  assert.equal(resultados[0].tipo, 'preprint');
  assert.equal(resultados[0].id, 'PPR-PPR1');
});

// ---------------------------------------------------------------- ERIC

const docEric = {
  id: 'ED676522',
  title: 'Artificial Intelligence through Young Eyes: Students&apos; Perspectives',
  author: ['Chad P. Salyer'],
  description: 'A study.',
  source: 'ProQuest LLC',
  sourceid: 'v21 n3 p1-9 2024',
  publicationdateyear: 2024,
  publicationtype: ['Dissertations/Theses - Doctoral Dissertations'],
  peerreviewed: 'F',
  e_fulltextauth: 1,
  language: ['English'],
};

test('ERIC: consulta con años, filas y comienzo', async (t) => {
  const pedidas = fetchFalso(t, () => ({ response: { numFound: 3716, docs: [docEric] } }));
  const { resultados, total, caida } = await eric.buscar({ consulta, pagina: 2, porPagina: 5, desde: 2020, hasta: 2024 });

  assert.equal(caida, false);
  assert.equal(total, 3716);
  const u = pedidas[0];
  assert.equal(u.origin + u.pathname, 'https://api.ies.ed.gov/eric/');
  assert.equal(u.searchParams.get('search'), `(${consulta}) AND publicationdateyear:[2020 TO 2024]`);
  assert.equal(u.searchParams.get('format'), 'json');
  assert.equal(u.searchParams.get('rows'), '5');
  assert.equal(u.searchParams.get('start'), '5');

  const r = resultados[0];
  assert.equal(r.id, 'ED676522');
  assert.equal(r.doi, null);
  assert.equal(r.autores, 'Salyer, C.');
  assert.equal(r.tipo, 'dissertation');
  assert.equal(r.titulo, "Artificial Intelligence through Young Eyes: Students' Perspectives");
  assert.equal(r.enlace, 'https://eric.ed.gov/?id=ED676522');
  assert.equal(r.pdfLibre, 'https://files.eric.ed.gov/fulltext/ED676522.pdf');
  assert.equal(r.revisadoPorPares, false);
  assert.equal(r.idioma, 'en');
});

test('ERIC: sin consulta booleana une las palabras con AND; el DOI sale de la url', async (t) => {
  const pedidas = fetchFalso(t, () => ({
    response: {
      numFound: 1,
      docs: [{ ...docEric, id: 'EJ1465537', e_fulltextauth: 0, url: 'https://doi.org/10.26634/jet.21.3.21318', publicationtype: ['Journal Articles'], peerreviewed: 'T' }],
    },
  }));
  const { resultados } = await eric.buscar({ palabras: 'artificial intelligence' });
  assert.equal(pedidas[0].searchParams.get('search'), '(artificial AND intelligence)');
  assert.equal(resultados[0].doi, '10.26634/jet.21.3.21318');
  assert.equal(resultados[0].tipo, 'article');
  assert.equal(resultados[0].pdfLibre, null);
  assert.equal(resultados[0].revisadoPorPares, true);
});

test('ERIC: si no contesta, caída', async (t) => {
  fetchFalso(t, () => null);
  assert.equal((await eric.buscar({ consulta })).caida, true);
});

test('ERIC: porIds solo acepta EJ/ED y devuelve fichas', async (t) => {
  const pedidas = fetchFalso(t, () => ({ response: { numFound: 1, docs: [docEric] } }));
  const fichas = await eric.porIds(['ED676522', 'ej1457281', 'XX1', 'ED1 OR id:*']);
  assert.equal(pedidas[0].searchParams.get('search'), 'id:ED676522 OR id:EJ1457281');
  assert.equal(fichas.length, 1);
  assert.deepEqual(
    { volume: fichas[0].volume, issue: fichas[0].issue, pages: fichas[0].pages, itemType: fichas[0].itemType, authors: fichas[0].authors },
    { volume: '21', issue: '3', pages: '1-9', itemType: 'thesis', authors: 'Salyer, C.' },
  );
  assert.deepEqual(await eric.porIds(['nada']), []);
});
