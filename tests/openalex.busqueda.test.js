'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const openalex = require('../src/modules/references/openalex.client');

/**
 * La búsqueda abierta: primero en título y resumen, y lo que falte, en todo.
 *
 * Con la búsqueda completa sola salían estudios que solo nombraban «Lima» en
 * alguna parte; con título y resumen sola, casi nada. Se prueba que va la
 * precisa delante, que la amplia completa sin repetir, y que no se pregunta
 * dos veces si la primera ya basta.
 */

const obra = (id, titulo) => ({
  id: `https://openalex.org/${id}`,
  title: titulo,
  authorships: [],
  publication_year: 2024,
  cited_by_count: 0,
});

function fetchFalso(t, { precisa, amplia }) {
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const filtro = new URL(url).searchParams.get('filter');
    const esPrecisa = filtro.includes('title_and_abstract.search:');
    pedidas.push({ precisa: esPrecisa, url: String(url) });
    const resultados = esPrecisa ? precisa : amplia;
    if (resultados === null) return { ok: false, status: 503, text: async () => 'pausa' };
    return { ok: true, json: async () => ({ results: resultados, meta: { count: resultados.length } }) };
  });
  return pedidas;
}

test('lo que coincide en título y resumen va delante, y lo amplio completa sin repetir', async (t) => {
  const pedidas = fetchFalso(t, {
    precisa: [obra('W1', 'Comercio electrónico y satisfacción en Lima Metropolitana')],
    amplia: [obra('W2', 'Gamarra'), obra('W1', 'repetida'), obra('W3', 'Cajas municipales')],
  });

  const { fuentes, caida } = await openalex.buscar({ tema: 'comercio electrónico Lima', cuantas: 3 });

  assert.equal(caida, false);
  assert.deepEqual(
    fuentes.map((f) => f.titulo),
    ['Comercio electrónico y satisfacción en Lima Metropolitana', 'Gamarra', 'Cajas municipales'],
  );
  assert.equal(pedidas.length, 2);
});

test('si la búsqueda precisa ya llena, no se pregunta otra vez', async (t) => {
  const pedidas = fetchFalso(t, {
    precisa: [obra('W1', 'uno'), obra('W2', 'dos')],
    amplia: [obra('W9', 'no debería pedirse')],
  });

  const { fuentes } = await openalex.buscar({ tema: 'AI personalization', cuantas: 2 });

  assert.equal(fuentes.length, 2);
  assert.equal(pedidas.length, 1);
  assert.ok(pedidas[0].precisa);
});

test('una coma en el tema no rompe el filtro de OpenAlex', async (t) => {
  const pedidas = fetchFalso(t, { precisa: [obra('W1', 'uno')], amplia: [] });

  await openalex.buscar({ tema: 'confianza, lealtad', cuantas: 1 });

  const filtro = new URL(pedidas[0].url).searchParams.get('filter');
  assert.match(filtro, /title_and_abstract\.search:confianza {2}lealtad$/);
});

test('si OpenAlex no contesta a ninguna de las dos, se dice caída', async (t) => {
  fetchFalso(t, { precisa: null, amplia: null });

  const resultado = await openalex.buscar({ tema: 'lo que sea', cuantas: 3 });

  assert.deepEqual(resultado, { fuentes: [], total: 0, caida: true });
});
