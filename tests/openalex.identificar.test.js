'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const openalex = require('../src/modules/references/openalex.client');

test('la identificación por título admite libros e informes sin el filtro de artículos', async (t) => {
  let consulta;
  t.mock.method(globalThis, 'fetch', async (url) => {
    consulta = new URL(url);
    return { ok: true, json: async () => ({ results: [{
      id: 'https://openalex.org/W123', title: 'Manual de gestión educativa',
      authorships: [], publication_year: 2021, type: 'book',
      primary_location: { landing_page_url: 'https://hdl.handle.net/123/456', source: { display_name: 'Editorial universitaria' } },
    }] }) };
  });
  const fichas = await openalex.buscarPorTitulo('manual de gestión educativa');
  assert.equal(consulta.searchParams.get('search'), 'manual de gestión educativa');
  assert.equal(consulta.searchParams.has('filter'), false);
  assert.equal(consulta.searchParams.get('per_page'), '6');
  assert.equal(fichas[0].itemType, 'book');
  assert.equal(fichas[0].url, 'https://hdl.handle.net/123/456');
});
