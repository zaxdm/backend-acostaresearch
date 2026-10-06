'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const openalex = require('../src/modules/references/openalex.client');
const crossref = require('../src/modules/references/crossref.client');
const propiasRepository = require('../src/modules/references/propias.repository');
const propiasService = require('../src/modules/references/propias.service');

/**
 * La pestaña de SciELO: busca en OpenAlex filtrando por las revistas que están
 * en SciELO, y guarda lo marcado en la biblioteca del tesista, tenga o no DOI.
 */

const obra = (id, extra = {}) => ({
  id: `https://openalex.org/${id}`,
  title: `Artículo ${id}`,
  authorships: [{ author: { display_name: 'Rosa Isabel Tecocha Portocarrero' }, countries: ['PE'] }],
  publication_year: 2024,
  cited_by_count: 3,
  language: 'es',
  primary_location: {
    landing_page_url: `https://www.scielo.org.pe/${id}`,
    source: { display_name: 'Revista de Psicología' },
  },
  ...extra,
});

function fetchFalso(t, respuesta) {
  const pedidas = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    pedidas.push(new URL(url));
    if (respuesta === null) return { ok: false, status: 503, text: async () => 'pausa', headers: null };
    return { ok: true, json: async () => respuesta };
  });
  return pedidas;
}

test('busca solo en revistas de SciELO, en título y resumen, con los filtros pedidos', async (t) => {
  const pedidas = fetchFalso(t, { results: [obra('W1')], meta: { count: 150 } });

  const { resultados, total, caida } = await openalex.buscarEnScielo({
    tema: 'pensamiento crítico, universitarios',
    pagina: 2,
    orden: 'citas',
    idioma: 'es',
    desdeAnio: 2020,
    hastaAnio: 2024,
  });

  assert.equal(caida, false);
  assert.equal(total, 150);
  const url = pedidas[0];
  const filtro = url.searchParams.get('filter');
  assert.match(filtro, /^primary_location\.source\.listed_in:scielo,/);
  assert.match(filtro, /type:article\|review/);
  assert.match(filtro, /language:es/);
  assert.match(filtro, /from_publication_date:2020-01-01/);
  assert.match(filtro, /to_publication_date:2024-12-31/);
  // La coma del tema no puede partir el filtro.
  assert.match(filtro, /title_and_abstract\.search:pensamiento crítico {2}universitarios$/);
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('sort'), 'cited_by_count:desc');
  assert.equal(url.searchParams.has('search'), false);

  assert.deepEqual(
    { id: resultados[0].id, revista: resultados[0].revista, enlace: resultados[0].enlace },
    { id: 'W1', revista: 'Revista de Psicología', enlace: 'https://www.scielo.org.pe/W1' },
  );
  assert.equal(resultados[0].autores, 'Tecocha Portocarrero, R.');
});

test('si OpenAlex no contesta, se dice caída y no una lista vacía', async (t) => {
  fetchFalso(t, null);
  const resultado = await openalex.buscarEnScielo({ tema: 'lo que sea' });
  assert.equal(resultado.caida, true);
});

test('guarda las de SciELO con DOI por el DOI y las que no lo tienen por OpenAlex', async (t) => {
  fetchFalso(t, {
    results: [obra('W1', { doi: 'https://doi.org/10.4067/S0718-07052018000100089' }), obra('W2')],
  });
  t.mock.method(crossref, 'porDoi', async () => ({ authors: 'Tecocha Portocarrero, R. I.' }));
  t.mock.method(propiasRepository, 'contar', async () => 10);
  t.mock.method(propiasRepository, 'contarSinResumen', async () => 0);
  let guardadas = null;
  t.mock.method(propiasRepository, 'guardarLote', async (_userId, filas) => {
    guardadas = filas;
    return { guardadas: filas.length, repetidas: 0 };
  });

  const resultado = await propiasService.importarDeScielo({
    userId: 'u1',
    ids: ['https://openalex.org/W1', 'W2', 'W2', 'no-es-un-id'],
  });

  assert.equal(resultado.pedidas, 2);
  assert.equal(resultado.guardadas, 2);
  assert.deepEqual(
    guardadas.map((f) => f.sourceRef),
    ['doi:10.4067/s0718-07052018000100089', 'openalex:W2'],
  );
  // Los autores de Crossref mandan cuando hay DOI.
  assert.equal(guardadas[0].authors, 'Tecocha Portocarrero, R. I.');
  assert.equal(crossref.porDoi.mock.callCount(), 1);
});

test('sin ningún identificador válido no se consulta nada', async () => {
  await assert.rejects(
    propiasService.importarDeScielo({ userId: 'u1', ids: ['<script>'] }),
    /No marcaste ningún artículo/,
  );
});

test('marca como tuyas las que ya tiene, por la misma identidad con la que se guardan', async (t) => {
  t.mock.method(propiasRepository, 'cualesTiene', async () => ['openalex:W2']);
  const marcadas = await propiasService.marcarLasQueTiene('u1', [
    { id: 'W1', doi: '10.1/ABC' },
    { id: 'W2', doi: null },
  ]);
  assert.deepEqual(
    marcadas.map((r) => r.tuya),
    [false, true],
  );
  assert.deepEqual(propiasRepository.cualesTiene.mock.calls[0].arguments[1], ['doi:10.1/abc', 'openalex:W2']);
});

test('con los conceptos del buscador de Scopus, la búsqueda va armada con sus sinónimos', async (t) => {
  const { busquedaDeConceptos } = require('../src/modules/scopus/scopus.cuentas');
  const consulta = busquedaDeConceptos([
    { nombre: 'critical thinking', sinonimos: ['pensamiento crítico'] },
    { nombre: 'university students', sinonimos: [] },
  ]);
  assert.equal(consulta, '("critical thinking" OR "pensamiento crítico") AND ("university students")');

  const pedidas = fetchFalso(t, { results: [], meta: { count: 0 } });
  await openalex.buscarEnScielo({ consulta, porPagina: 10 });
  const url = pedidas[0];
  assert.equal(url.searchParams.get('per_page'), '10');
  assert.match(url.searchParams.get('filter'), /title_and_abstract\.search:\("critical thinking" OR "pensamiento crítico"\) AND/);
});

test('el copiloto devuelve los términos en español aparte, limpios y sin comodines', () => {
  const { normalizar } = require('../src/modules/scopus/scopus.consulta');
  const { conceptos } = normalizar({
    conceptos: [
      {
        nombre: 'mining industry',
        sinonimos: ['mining sector'],
        espanol: ['minería', 'minero*', 'Minería', 'sector (minero)', 42],
      },
    ],
  });
  assert.deepEqual(conceptos[0].sinonimos, ['mining sector']);
  assert.deepEqual(conceptos[0].espanol, ['minería', 'minero', 'sector minero']);
});

test('los comodines de Scopus no viajan a OpenAlex', () => {
  const { busquedaDeConceptos } = require('../src/modules/scopus/scopus.cuentas');
  assert.equal(
    busquedaDeConceptos([{ nombre: 'undergraduate*', sinonimos: ['undergraduate'] }]),
    '("undergraduate")',
  );
});

test('acusa solo las palabras que no tiene ningún trabajo', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const filtro = new URL(url).searchParams.get('filter');
    return { ok: true, json: async () => ({ meta: { count: filtro.endsWith('minbero') ? 0 : 16527 } }) };
  });
  assert.deepEqual(await openalex.palabrasSinUso(['inteligencia', 'minbero', 'sector']), ['minbero']);
});
