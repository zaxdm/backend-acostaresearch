'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const semanticscholar = require('../src/modules/externas/semanticscholar');
const arxiv = require('../src/modules/externas/arxiv');
const dblp = require('../src/modules/externas/dblp');

/**
 * Bases externas, grupo 1: Semantic Scholar, arXiv y DBLP. Se simula `fetch`:
 * se comprueba lo que se pide, cómo se lee lo que llega y que un fallo no
 * tumba la búsqueda.
 */

/** `respuestas`: lista de { status, json } o { status, texto }; la última se repite. */
function fetchFalso(t, ...respuestas) {
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url, opciones) => {
    pedidas.push({ url: new URL(url), headers: opciones?.headers ?? {} });
    const r = respuestas[Math.min(pedidas.length - 1, respuestas.length - 1)];
    if (r === null) throw new Error('sin red');
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (r.json === undefined) throw new Error('no es JSON');
        return r.json;
      },
      text: async () => r.texto ?? JSON.stringify(r.json ?? ''),
    };
  });
  return pedidas;
}

// ─── Semantic Scholar ────────────────────────────────────────────────────────

const ID_S2 = 'a'.repeat(40);
const papel = {
  paperId: ID_S2,
  externalIds: { DOI: '10.1234/ABC.5', ArXiv: '2101.00001' },
  title: 'AI in <i>education</i>',
  authors: [{ name: 'John Smith' }, { name: 'Ana López' }],
  year: 2022,
  venue: 'Comput. Educ.',
  journal: { name: 'Computers & Education', volume: '180', pages: ' 1-20' },
  abstract: 'Un resumen.',
  citationCount: 12,
  url: `https://www.semanticscholar.org/paper/${ID_S2}`,
  openAccessPdf: { url: 'https://example.org/a.pdf' },
  publicationTypes: ['Review', 'JournalArticle'],
};

test('Semantic Scholar: pide por palabras, con offset, límite y años', async (t) => {
  const pedidas = fetchFalso(t, { json: { total: 345, offset: 50, data: [papel] } });

  const r = await semanticscholar.buscar({
    consulta: '("artificial intelligence") AND ("education")',
    palabras: 'artificial intelligence education',
    pagina: 3,
    porPagina: 25,
    desde: 2020,
    hasta: 2024,
  });

  assert.equal(r.caida, false);
  assert.equal(r.total, 345);
  const url = pedidas[0].url;
  assert.equal(url.origin + url.pathname, 'https://api.semanticscholar.org/graph/v1/paper/search');
  assert.equal(url.searchParams.get('query'), 'artificial intelligence education');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('year'), '2020-2024');
  assert.match(url.searchParams.get('fields'), /openAccessPdf/);

  const [p] = r.resultados;
  assert.equal(p.id, ID_S2);
  assert.equal(p.doi, '10.1234/ABC.5');
  assert.equal(p.titulo, 'AI in education');
  assert.equal(p.autores, 'Smith, J.; López, A.');
  assert.equal(p.revista, 'Computers & Education');
  assert.equal(p.citas, 12);
  assert.equal(p.pdfLibre, 'https://example.org/a.pdf');
  assert.equal(p.tipo, 'review');
});

test('Semantic Scholar: solo «desde» va como «2020-», y la clave del .env viaja en x-api-key', async (t) => {
  t.after(() => delete process.env.SEMANTIC_SCHOLAR_API_KEY);
  process.env.SEMANTIC_SCHOLAR_API_KEY = 'clave-prueba';
  const pedidas = fetchFalso(t, { json: { total: 0, data: [] } });

  await semanticscholar.buscar({ palabras: 'x', pagina: 1, porPagina: 10, desde: 2020, hasta: null });

  assert.equal(pedidas[0].url.searchParams.get('year'), '2020-');
  assert.equal(pedidas[0].url.searchParams.get('offset'), '0');
  assert.equal(pedidas[0].headers['x-api-key'], 'clave-prueba');
});

test('Semantic Scholar: ante un 429 espera y reintenta una vez', async (t) => {
  t.mock.method(semanticscholar._reloj, 'esperar', async () => {});
  const pedidas = fetchFalso(t, { status: 429, texto: 'cupo' }, { json: { total: 1, data: [papel] } });

  const r = await semanticscholar.buscar({ palabras: 'x' });

  assert.equal(pedidas.length, 2);
  assert.equal(r.caida, false);
  assert.equal(r.resultados.length, 1);
});

test('Semantic Scholar: dos 429 seguidos o sin red, caída', async (t) => {
  t.mock.method(semanticscholar._reloj, 'esperar', async () => {});
  fetchFalso(t, { status: 429, texto: 'cupo' });
  assert.equal((await semanticscholar.buscar({ palabras: 'x' })).caida, true);
});

test('Semantic Scholar: sin red, caída', async (t) => {
  fetchFalso(t, null);
  assert.deepEqual(await semanticscholar.buscar({ palabras: 'x' }), { resultados: [], total: 0, caida: true });
});

test('Semantic Scholar: porIds pide cada id válido y devuelve Fichas', async (t) => {
  const pedidas = fetchFalso(t, { json: papel });

  const fichas = await semanticscholar.porIds([ID_S2, '../../borrar', 'b'.repeat(39), ID_S2]);

  assert.equal(pedidas.length, 1, 'los inválidos y repetidos no se piden');
  assert.equal(pedidas[0].url.pathname, `/graph/v1/paper/${ID_S2}`);
  assert.equal(fichas.length, 1);
  const f = fichas[0];
  assert.equal(f.id, ID_S2);
  assert.equal(f.doi, '10.1234/ABC.5');
  assert.equal(f.authors, 'Smith, J.; López, A.');
  assert.equal(f.year, 2022);
  assert.equal(f.source, 'Computers & Education');
  assert.equal(f.volume, '180');
  assert.equal(f.pages, '1-20');
  assert.equal(f.itemType, 'journalArticle');
});

test('Semantic Scholar: porIds no pide más de 25', async (t) => {
  const pedidas = fetchFalso(t, { json: papel });
  const ids = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(40, '0'));
  await semanticscholar.porIds(ids);
  assert.equal(pedidas.length, 25);
});

// ─── arXiv ───────────────────────────────────────────────────────────────────

const entrada = (id) => `
  <entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <title>Fairness in AI
      for Education</title>
    <updated>2022-06-23T13:29:39Z</updated>
    <link href="https://arxiv.org/abs/${id}v2" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/${id}v2" rel="related" type="application/pdf" title="pdf"/>
    <summary>Un resumen &amp; algo más.</summary>
    <published>2022-06-23T13:29:39Z</published>
    <author><name>Gianni Fenu</name></author>
    <author><name>Roberta Galici</name></author>
    <arxiv:doi>10.1007/978-3-031-11644-5_20</arxiv:doi>
    <arxiv:journal_ref>AIED 2022</arxiv:journal_ref>
  </entry>`;

const feed = (total, ...entradas) => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/abc</id>
  <title>arXiv Query</title>
  <opensearch:totalResults>${total}</opensearch:totalResults>
  ${entradas.join('\n')}
</feed>`;

test('arXiv: traduce la booleana a all:, pagina con start y filtra por fecha de envío', async (t) => {
  const pedidas = fetchFalso(t, { texto: feed(4628, entrada('2207.01490')) });

  const r = await arxiv.buscar({
    consulta: '("artificial intelligence" OR "AI") AND ("education") AND NOT ("robots")',
    palabras: 'artificial intelligence AI education',
    pagina: 2,
    porPagina: 10,
    desde: 2020,
    hasta: 2023,
  });

  assert.equal(r.caida, false);
  assert.equal(r.total, 4628);
  const url = pedidas[0].url;
  assert.equal(url.origin + url.pathname, 'https://export.arxiv.org/api/query');
  assert.equal(
    url.searchParams.get('search_query'),
    '((all:"artificial intelligence" OR all:"AI") AND (all:"education") ANDNOT (all:"robots")) AND submittedDate:[202001010000 TO 202312312359]',
  );
  assert.equal(url.searchParams.get('start'), '10');
  assert.equal(url.searchParams.get('max_results'), '10');
  assert.equal(url.searchParams.get('sortBy'), 'relevance');

  const [p] = r.resultados;
  assert.equal(p.id, '2207.01490');
  assert.equal(p.doi, '10.1007/978-3-031-11644-5_20');
  assert.equal(p.titulo, 'Fairness in AI for Education');
  assert.equal(p.autores, 'Fenu, G.; Galici, R.');
  assert.equal(p.anio, 2022);
  assert.equal(p.revista, 'AIED 2022');
  assert.equal(p.resumen, 'Un resumen & algo más.');
  assert.equal(p.enlace, 'https://arxiv.org/abs/2207.01490v2');
  assert.equal(p.pdfLibre, 'https://arxiv.org/pdf/2207.01490v2');
  assert.equal(p.tipo, 'preprint');
});

test('arXiv: sin booleana, las palabras con AND', async (t) => {
  const pedidas = fetchFalso(t, { texto: feed(0) });
  await arxiv.buscar({ palabras: 'deep learning', pagina: 1, porPagina: 5 });
  assert.equal(pedidas[0].url.searchParams.get('search_query'), 'all:deep AND all:learning');
  assert.equal(pedidas[0].url.searchParams.get('start'), '0');
});

test('arXiv: error de la API, respuesta que no es un feed o sin red, caída', async (t) => {
  const error = feed(1, '<entry><id>http://arxiv.org/api/errors#incorrect_id</id><title>Error</title></entry>');
  fetchFalso(t, { texto: error }, { texto: '<html>mantenimiento</html>' }, { status: 503, texto: 'no' }, null);
  for (let i = 0; i < 4; i++) assert.equal((await arxiv.buscar({ palabras: 'x' })).caida, true);
});

test('arXiv: porIds pide los válidos en una sola petición y devuelve Fichas', async (t) => {
  const pedidas = fetchFalso(t, { texto: feed(2, entrada('2207.01490'), entrada('hep-th/9901001')) });

  const fichas = await arxiv.porIds(['2207.01490', 'hep-th/9901001', '2207.01490', 'x&id_list=1', '../a']);

  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0].url.searchParams.get('id_list'), '2207.01490,hep-th/9901001');
  assert.deepEqual(
    fichas.map((f) => f.id),
    ['2207.01490', 'hep-th/9901001'],
  );
  assert.equal(fichas[0].authors, 'Fenu, G.; Galici, R.');
  assert.equal(fichas[0].itemType, 'preprint');
  assert.equal(fichas[0].source, 'AIED 2022');
  assert.equal(fichas[0].url, 'https://arxiv.org/abs/2207.01490v2');
});

test('arXiv: porIds sin ids válidos no pide nada', async (t) => {
  const pedidas = fetchFalso(t, { texto: feed(0) });
  assert.deepEqual(await arxiv.porIds(['nada', '']), []);
  assert.equal(pedidas.length, 0);
});

// ─── DBLP ────────────────────────────────────────────────────────────────────

const hit = (info) => ({ '@id': '1', info });
const revista = {
  authors: { author: [{ '@pid': '1/1', text: 'John Smith 0002' }, { '@pid': '2/2', text: 'Ana López' }] },
  title: 'AI in Education.',
  venue: 'Educ. Inf. Technol.',
  volume: '27',
  number: '3',
  pages: '1-20',
  year: '2022',
  type: 'Journal Articles',
  key: 'journals/eait/SmithL22',
  doi: '10.1007/S10639-022-1',
  ee: 'https://doi.org/10.1007/s10639-022-1',
  url: 'https://dblp.org/rec/journals/eait/SmithL22',
};
const congreso = {
  authors: { author: { '@pid': '3/3', text: 'Gianni Fenu' } },
  title: 'Fairness.',
  venue: 'AIED',
  year: '2022',
  type: 'Conference and Workshop Papers',
  key: 'conf/aied/Fenu22',
  ee: ['https://doi.org/10.1007/978-3-031-11644-5_20', 'https://arxiv.org/abs/2207.01490'],
  url: 'https://dblp.org/rec/conf/aied/Fenu22',
};
const corr = { ...congreso, type: 'Informal and Other Publications', key: 'journals/corr/abs-2207-01490', venue: 'CoRR' };

test('DBLP: pide por palabras con h y f, y lee revistas, congresos y CoRR', async (t) => {
  const pedidas = fetchFalso(t, {
    json: { result: { hits: { '@total': '812', hit: [hit(revista), hit(congreso), hit(corr)] } } },
  });

  const r = await dblp.buscar({
    consulta: '("artificial intelligence") AND ("education")',
    palabras: 'artificial intelligence education',
    pagina: 3,
    porPagina: 25,
    desde: 2020,
    hasta: 2024,
  });

  assert.equal(r.caida, false);
  assert.equal(r.total, 812);
  const url = pedidas[0].url;
  assert.equal(url.origin + url.pathname, 'https://dblp.org/search/publ/api');
  assert.equal(url.searchParams.get('q'), 'artificial intelligence education');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('h'), '25');
  assert.equal(url.searchParams.get('f'), '50');

  const [a, b, c] = r.resultados;
  assert.equal(a.id, 'journals/eait/SmithL22');
  assert.equal(a.doi, '10.1007/S10639-022-1');
  assert.equal(a.titulo, 'AI in Education');
  assert.equal(a.autores, 'Smith, J.; López, A.');
  assert.equal(a.anio, 2022);
  assert.equal(a.tipo, 'article');
  assert.equal(a.enlace, 'https://doi.org/10.1007/s10639-022-1');
  assert.equal(a.pdfLibre, null);
  assert.equal(a.resumen, null);

  assert.equal(b.tipo, 'other');
  assert.equal(b.autores, 'Fenu, G.', 'un autor solo llega como objeto, no como lista');
  assert.equal(b.pdfLibre, 'https://arxiv.org/pdf/2207.01490');
  assert.equal(c.tipo, 'preprint');
});

test('DBLP: la página anti-robots (HTML), un 429 o sin red, caída', async (t) => {
  fetchFalso(t, { status: 202, texto: '<!doctype html>Making sure you are not a bot' }, { status: 429, texto: '' }, null);
  for (let i = 0; i < 3; i++) assert.equal((await dblp.buscar({ palabras: 'x' })).caida, true);
});

test('DBLP: porIds lee el XML de cada registro válido', async (t) => {
  const xml = `<?xml version="1.0" encoding="US-ASCII"?>
<dblp>
<article key="journals/eait/SmithL22" mdate="2022-05-01">
<author pid="1/1">John Smith 0002</author>
<author pid="2/2">Ana L&#243;pez</author>
<title>AI in Education.</title>
<pages>1-20</pages>
<year>2022</year>
<volume>27</volume>
<journal>Educ. Inf. Technol.</journal>
<number>3</number>
<ee>https://doi.org/10.1007/s10639-022-1</ee>
<url>db/journals/eait/eait27.html#SmithL22</url>
</article>
</dblp>`;
  const pedidas = fetchFalso(t, { texto: xml });

  const fichas = await dblp.porIds(['journals/eait/SmithL22', '../../etc/passwd', 'journals/a/../b', 'http://x']);

  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0].url.href, 'https://dblp.org/rec/journals/eait/SmithL22.xml');
  assert.equal(fichas.length, 1);
  const f = fichas[0];
  assert.equal(f.id, 'journals/eait/SmithL22');
  assert.equal(f.doi, '10.1007/s10639-022-1');
  assert.equal(f.title, 'AI in Education');
  assert.equal(f.year, 2022);
  assert.equal(f.source, 'Educ. Inf. Technol.');
  assert.equal(f.volume, '27');
  assert.equal(f.issue, '3');
  assert.equal(f.pages, '1-20');
  assert.equal(f.itemType, 'journalArticle');
  assert.equal(f.authors, 'Smith, J.; López, A.', 'las entidades numéricas del XML se decodifican');
});

test('DBLP: un registro informal de CoRR es preprint', async (t) => {
  fetchFalso(t, {
    texto: '<dblp><article key="journals/corr/abs-2207-01490" publtype="informal"><author>Gianni Fenu</author><title>F.</title><year>2022</year><journal>CoRR</journal></article></dblp>',
  });
  const [f] = await dblp.porIds(['journals/corr/abs-2207-01490']);
  assert.equal(f.itemType, 'preprint');
  assert.equal(f.url, 'https://dblp.org/rec/journals/corr/abs-2207-01490');
});
