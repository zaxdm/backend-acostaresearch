'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

for (const [modulo, exports] of [
  ['../src/config/env', { OPENALEX_MAILTO: 'pruebas@example.org' }],
  ['../src/config/logger', { info() {}, warn() {}, error() {} }],
  ['../src/lib/prisma', {}],
]) {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const crossref = require('../src/modules/references/crossref.client');
const externa = require('../src/modules/externas/crossref');
const openalex = require('../src/modules/references/openalex.client');
const propias = require('../src/modules/references/propias.service');
const repositorio = require('../src/modules/references/propias.repository');
const scopus = require('../src/modules/scopus/scopus.mapper');

// Ejemplo recortado del caso Jamir: el DOI apareció en línea cuatro años antes
// de su asignación al volumen 25, número 2_suppl. No consulta servicios reales.
const JAMIR = {
  DOI: '10.1177/0972150920954612',
  title: ['Impact of Global Financial Crisis on Indian Handicrafts Exports'],
  author: [{ family: 'Jamir' }],
  'container-title': ['Global Business Review'],
  type: 'journal-article',
  volume: '25',
  issue: '2_suppl',
  issued: { 'date-parts': [[2020]] },
  'published-online': { 'date-parts': [[2020]] },
  'published-print': { 'date-parts': [[2024]] },
  'journal-issue': { 'published-print': { 'date-parts': [[2024]] } },
};

const EN_LINEA = {
  DOI: '10.1000/solo-online',
  title: ['Artículo solo en línea'],
  type: 'journal-article',
  issued: { 'date-parts': [[2019]] },
  'published-online': { 'date-parts': [[2020]] },
};

function responder(t, mensaje = JAMIR) {
  const llamadas = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    assert.equal(u.hostname, 'api.crossref.org');
    llamadas.push(u);
    assert.equal(u.searchParams.has('select'), false, 'journal-issue no es seleccionable en Crossref');
    const message = u.pathname === '/works'
      ? { items: [mensaje], 'total-results': 1 }
      : mensaje;
    return { ok: true, status: 200, json: async () => ({ message }) };
  });
  return llamadas;
}

test('Crossref por DOI: prima el año del número y solo online conserva el año online', async (t) => {
  const casos = [
    ['número suplementario', JAMIR, 2024],
    ['fecha del número antes que la impresa del artículo', {
      ...JAMIR, 'published-print': { 'date-parts': [[2023]] },
    }, 2024],
    ['sin journal-issue usa published-print', { ...JAMIR, 'journal-issue': undefined }, 2024],
    ['sin fecha impresa usa issued', {
      ...JAMIR, 'journal-issue': undefined, 'published-print': undefined,
      issued: { 'date-parts': [[2024]] },
    }, 2024],
    ['último recurso online con volumen', {
      ...JAMIR, 'journal-issue': undefined, 'published-print': undefined, issued: undefined,
    }, 2020],
    ['sin volumen ni número usa online', EN_LINEA, 2020],
    ['sin fechas', { DOI: '10.1000/sin-fecha', title: ['Sin fecha'] }, null],
  ];
  for (const [nombre, mensaje, esperado] of casos) {
    await t.test(nombre, async (t) => {
      responder(t, mensaje);
      const ficha = await crossref.porDoi(mensaje.DOI);
      assert.equal(ficha.year, esperado);
      assert.equal(ficha.issue, mensaje.issue ?? null);
    });
  }
});

test('los dos buscadores Crossref y la importación externa usan el mismo año', async (t) => {
  for (const mensaje of [JAMIR, EN_LINEA]) {
    await t.test(mensaje.DOI, async (t) => {
      const llamadas = responder(t, mensaje);
      const esperado = mensaje === JAMIR ? 2024 : 2020;
      assert.equal((await crossref.buscar({ tema: 'exports' })).fuentes[0].anio, esperado);
      assert.equal((await externa.buscar({ palabras: 'exports' })).resultados[0].anio, esperado);
      assert.equal((await externa.porIds([mensaje.DOI]))[0].year, esperado);
      assert.equal(llamadas.length, 3);
    });
  }
});

test('completar volumen/número corrige el año sin cambiar ref ni sourceRef', async (t) => {
  const llamadas = responder(t);
  const ficha = {
    doi: JAMIR.DOI, ref: 'AR123', sourceRef: `doi:${JAMIR.DOI}`,
    title: JAMIR.title[0], year: 2020, source: 'Global Business Review',
  };
  const completa = await crossref.completar(ficha);
  assert.equal(completa.year, 2024);
  assert.equal(completa.volume, '25');
  assert.equal(completa.issue, '2_suppl');
  assert.equal(completa.ref, ficha.ref);
  assert.equal(completa.sourceRef, ficha.sourceRef);
  assert.equal(ficha.year, 2020, 'no muta la ficha recibida');
  assert.equal(llamadas.length, 1);
});

test('al unir conserva el año si Crossref cae o no tiene fecha, y rellena un año ausente', () => {
  const ficha = { year: 2020, volume: '25', issue: '2_suppl' };
  assert.equal(crossref.unir(ficha, null).year, 2020);
  assert.equal(crossref.unir(ficha, { year: null }).year, 2020);
  assert.equal(crossref.unir({ ...ficha, year: null }, { year: 2024 }).year, 2024);
});

test('Zotero y Mendeley conservan su ficha al completar con DOI', async (t) => {
  const llamadas = responder(t);
  for (const origin of ['ZOTERO', 'MENDELEY']) {
    const ficha = { origin, doi: JAMIR.DOI, year: 2020, title: 'Título revisado' };
    assert.deepEqual(await crossref.completar(ficha), ficha);
    assert.deepEqual(crossref.unir(ficha, { year: 2024, volume: '25' }), ficha);
  }
  assert.equal(llamadas.length, 0);
});

test('Scopus completado por DOI aplica el año de Crossref y rehace la búsqueda', async (t) => {
  responder(t);
  const deCrossref = await crossref.porDoi(JAMIR.DOI);
  const fila = { ref: 'AR123', sourceRef: `doi:${JAMIR.DOI}`, year: 2020, title: 'Exports' };
  const completa = scopus.completar(fila, { deCrossref, deOpenAlex: { year: 2020 } });
  assert.equal(completa.year, 2024);
  assert.match(completa.busqueda, /2024/);
  assert.doesNotMatch(completa.busqueda, /2020/);
  assert.equal(completa.ref, fila.ref);
  assert.equal(completa.sourceRef, fila.sourceRef);
});

test('guardar por DOI, SciELO/OpenAlex y bases externas usa 2024 sin nuevas consultas', async (t) => {
  for (const via of ['doi', 'scielo', 'externas']) {
    await t.test(via, async (t) => {
      const llamadas = responder(t);
      const ficha = {
        id: 'W123', doi: JAMIR.DOI, title: JAMIR.title[0], year: 2020,
        volume: '25', issue: '2_suppl',
      };
      t.mock.method(openalex, 'porDoi', async () => ({ ...ficha }));
      t.mock.method(openalex, 'porIds', async () => [{ ...ficha }]);
      t.mock.method(externa, 'porIds', async () => [{ ...ficha }]);
      t.mock.method(repositorio, 'contar', async () => 0);
      t.mock.method(repositorio, 'contarSinResumen', async () => 1);
      let guardadas;
      t.mock.method(repositorio, 'guardarLote', async (_userId, filas) => {
        guardadas = filas;
        return { guardadas: filas.length, repetidas: 0 };
      });
      if (via === 'doi') await propias.importarPorDoi({ userId: 'u1', dois: [JAMIR.DOI] });
      if (via === 'scielo') await propias.importarDeScielo({ userId: 'u1', ids: ['W123'] });
      if (via === 'externas') await propias.importarDeExternas({ userId: 'u1', ids: [`crossref:${JAMIR.DOI}`] });
      assert.equal(guardadas[0].year, 2024);
      assert.equal(guardadas[0].sourceRef, `doi:${JAMIR.DOI}`);
      assert.match(guardadas[0].busqueda, /2024/);
      assert.equal(llamadas.length, 1);
    });
  }
});
