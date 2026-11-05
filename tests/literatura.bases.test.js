'use strict';

/**
 * «buscar_en_la_literatura» con otra base (5-nov-2026): PubMed, Europe PMC,
 * Semantic Scholar o CORE, las del buscador de la web.
 *
 * Lo que se prueba: con `base` se busca allí y las fuentes salen con su cita y
 * el nombre de la base; si esa base no está activa (falta su clave) o no
 * responde, se busca en OpenAlex y se avisa (`baseSinRespuesta`); y sin `base`
 * todo sigue como antes, solo OpenAlex.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const llamadas = { openalex: 0, pubmed: [] };
let pubmedActiva = true;
let pubmedCaida = false;

sustituir('../src/modules/references/openalex.client', {
  buscar: async () => {
    llamadas.openalex += 1;
    return {
      caida: false,
      total: 1,
      fuentes: [{ titulo: 'De OpenAlex', autores: 'Pérez, A.', anio: 2024, revista: 'Rev', doi: '10.1/oa', citas: 3 }],
    };
  },
});

sustituir('../src/modules/externas', {
  base: (clave) =>
    clave === 'pubmed'
      ? {
          nombre: 'PubMed',
          activa: () => pubmedActiva,
          buscar: async (opciones) => {
            llamadas.pubmed.push(opciones);
            if (pubmedCaida) return { resultados: [], total: 0, caida: true };
            return {
              caida: false,
              total: 40,
              resultados: [
                { titulo: 'Nursing burnout', autores: 'Smith, J.', anio: 2023, revista: 'J Nurs', doi: '10.1/pm', citas: 0 },
              ],
            };
          },
        }
      : null,
});

const referenceService = require('../src/modules/references/reference.service');

test('con base pubmed se busca en PubMed, con su nombre y su cita', async () => {
  const r = await referenceService.buscarEnLaLiteratura({ tema: 'nursing burnout', base: 'pubmed', cuantas: 5, pais: 'pe' });
  assert.equal(r.origen, 'pubmed');
  assert.equal(r.nombreDeLaBase, 'PubMed');
  assert.equal(r.fuentes[0].titulo, 'Nursing burnout');
  assert.match(r.fuentes[0].cita, /Smith/);
  assert.deepEqual(r.filtrosSinAplicar, ['país pe'], 'PubMed no filtra por país: se dice');
  assert.equal(llamadas.pubmed.at(-1).porPagina, 5);
});

test('si la base no está activa, se busca en OpenAlex y se avisa', async () => {
  pubmedActiva = false;
  const antes = llamadas.openalex;
  try {
    const r = await referenceService.buscarEnLaLiteratura({ tema: 'nursing burnout', base: 'pubmed' });
    assert.equal(r.origen, 'openalex');
    assert.equal(r.baseSinRespuesta, 'pubmed');
    assert.equal(llamadas.openalex, antes + 1);
  } finally {
    pubmedActiva = true;
  }
});

test('si la base no responde, también OpenAlex', async () => {
  pubmedCaida = true;
  try {
    const r = await referenceService.buscarEnLaLiteratura({ tema: 'nursing burnout', base: 'pubmed' });
    assert.equal(r.origen, 'openalex');
    assert.equal(r.baseSinRespuesta, 'pubmed');
  } finally {
    pubmedCaida = false;
  }
});

test('sin base, como antes: solo OpenAlex y sin aviso', async () => {
  const r = await referenceService.buscarEnLaLiteratura({ tema: 'inteligencia artificial' });
  assert.equal(r.origen, 'openalex');
  assert.equal(r.baseSinRespuesta, null);
  assert.equal(r.fuentes[0].titulo, 'De OpenAlex');
});
