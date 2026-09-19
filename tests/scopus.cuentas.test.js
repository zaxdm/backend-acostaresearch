'use strict';

/**
 * Los números aproximados de los filtros, con OpenAlex.
 *
 *   · La búsqueda que se le hace a OpenAlex es la misma que la de Scopus:
 *     sinónimos con OR, conceptos con AND, y sin nada que la rompa.
 *   · El área vuelve con el código de Scopus, para marcar su casilla.
 *   · El autor vuelve como lo encuentra AUTHOR-NAME: «Apellido, I.».
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/references/openalex.client', {
  agrupar: async () => null,
  nombreApa: (nombre) => (nombre === 'Sudhakar Geruganti' ? 'Geruganti, S.' : nombre),
});

const { aproximadas, filtroDe } = require('../src/modules/scopus/scopus.cuentas');

test('el filtro de OpenAlex: sinónimos con OR, conceptos con AND, sin comillas ni operadores sueltos', () => {
  const filtro = filtroDe({
    conceptos: [
      { nombre: 'critical thinking', sinonimos: ['critical reasoning'] },
      { nombre: '"ChatGPT" OR (GPT)', sinonimos: [] },
    ],
    desde: 2019,
    hasta: 2025,
  });
  assert.equal(
    filtro,
    'title_and_abstract.search:("critical thinking" OR "critical reasoning") AND ("ChatGPT GPT"),publication_year:2019-2025',
  );
});

test('el área vuelve con su código de Scopus y el autor como lo busca AUTHOR-NAME', async () => {
  const agrupar = async (_filtro, grupo) => {
    if (grupo === 'primary_topic.field.id') {
      return { total: 50, grupos: [{ clave: 'https://openalex.org/fields/33', nombre: 'Social Sciences', obras: 30 }] };
    }
    if (grupo === 'authorships.author.id') {
      return { total: 50, grupos: [{ clave: 'A1', nombre: 'Sudhakar Geruganti', obras: 4 }] };
    }
    return { total: 50, grupos: [{ clave: 'x', nombre: 'India', obras: 9 }] };
  };

  const { total, grupos } = await aproximadas({ conceptos: [{ nombre: 'area y autor' }] }, { agrupar });

  assert.equal(total, 50);
  assert.deepEqual(grupos.area, [{ valor: 'SOCI', texto: 'Social Sciences', n: 30 }]);
  assert.deepEqual(grupos.autor, [{ valor: 'Geruganti, S.', texto: 'Sudhakar Geruganti', n: 4 }]);
  assert.deepEqual(grupos.pais, [{ valor: 'India', texto: 'India', n: 9 }]);
});

test('si OpenAlex no contesta, sin números en vez de un error', async () => {
  const resultado = await aproximadas({ conceptos: [{ nombre: 'nadie contesta' }] }, { agrupar: async () => null });
  assert.deepEqual(resultado, { total: null, grupos: {} });
});
