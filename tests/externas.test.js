'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const externas = require('../src/modules/externas');
const latinoamerica = require('../src/modules/externas/latinoamerica');
const lareferencia = require('../src/modules/references/lareferencia.client');
const openalex = require('../src/modules/references/openalex.client');
const crossref = require('../src/modules/references/crossref.client');
const propiasRepository = require('../src/modules/references/propias.repository');
const propiasService = require('../src/modules/references/propias.service');

/**
 * Las bases externas del menú «Ver»: que todas cumplan el contrato de
 * `externas/index.js` y que lo marcado se guarde sin creer al navegador.
 */

test('todas las bases cumplen el contrato y no repiten clave', () => {
  const claves = new Set();
  for (const b of externas.BASES) {
    assert.match(b.clave, /^[a-z0-9]+$/, `clave de ${b.nombre}`);
    assert.ok(!claves.has(b.clave), `clave repetida: ${b.clave}`);
    claves.add(b.clave);
    assert.equal(typeof b.nombre, 'string');
    assert.equal(typeof b.detalle, 'string');
    assert.equal(typeof b.activa, 'function');
    assert.equal(typeof b.buscar, 'function');
    assert.equal(typeof b.porIds, 'function');
  }
  // Las de aquí no pueden llamarse como las fijas del menú.
  for (const fija of ['todo', 'scopus', 'scielo', 'openalex', 'tesis']) assert.ok(!claves.has(fija));
  assert.deepEqual(
    externas.lista().map((b) => Object.keys(b).sort()),
    externas.BASES.map(() => ['activa', 'clave', 'detalle', 'nombre']),
  );
});

test('Tesis de Latinoamérica busca en toda la red y dice el país', async (t) => {
  t.mock.method(lareferencia, 'buscar', async () => ({
    total: 2491,
    fichas: [
      {
        id: 'lareferencia:EC_ef8b0c201410986754c6a909ebce48fe',
        title: 'La IA en el aula',
        authors: 'Pérez, J.',
        year: 2025,
        source: 'Universidad Técnica del Norte',
        itemType: 'masterThesis',
        url: 'https://repositorio.utn.edu.ec/handle/1/2',
        abstract: 'Resumen',
      },
    ],
  }));

  const { resultados, total, caida } = await latinoamerica.buscar({ consulta: 'ia', pagina: 2, porPagina: 25 });

  assert.equal(caida, false);
  assert.equal(total, 2491);
  assert.equal(lareferencia.buscar.mock.calls[0].arguments[0].toda, true);
  assert.equal(lareferencia.buscar.mock.calls[0].arguments[0].pagina, 2);
  assert.deepEqual(
    { id: resultados[0].id, tipo: resultados[0].tipo, revista: resultados[0].revista },
    {
      id: 'EC_ef8b0c201410986754c6a909ebce48fe',
      tipo: 'dissertation',
      revista: 'Universidad Técnica del Norte · EC',
    },
  );
});

test('si LA Referencia falla, se dice caída', async (t) => {
  t.mock.method(lareferencia, 'buscar', async () => {
    throw new Error('Solr');
  });
  assert.equal((await latinoamerica.buscar({ consulta: 'ia' })).caida, true);
});

test('guarda lo marcado pidiendo la ficha a su base; con DOI por DOI, sin DOI por base:id', async (t) => {
  const base = externas.base('latinoamerica');
  t.mock.method(base, 'porIds', async (ids) =>
    ids.map((id, i) => ({
      id,
      doi: i === 0 ? '10.1234/ABC' : null,
      title: `Tesis ${id}`,
      authors: 'Pérez, J.',
      year: 2024,
      itemType: 'masterThesis',
    })),
  );
  t.mock.method(openalex, 'porDoi', async () => ({ title: 'Título de OpenAlex', abstract: null }));
  t.mock.method(crossref, 'porDoi', async () => null);
  t.mock.method(propiasRepository, 'contar', async () => 3);
  t.mock.method(propiasRepository, 'contarSinResumen', async () => 0);
  let guardadas = null;
  t.mock.method(propiasRepository, 'guardarLote', async (_u, filas) => {
    guardadas = filas;
    return { guardadas: filas.length, repetidas: 0 };
  });

  const r = await propiasService.importarDeExternas({
    userId: 'u1',
    ids: [
      'latinoamerica:EC_1',
      'latinoamerica:CL_2',
      'latinoamerica:CL_2',
      'inventada:X',
      'sin-dos-puntos',
    ],
  });

  assert.equal(r.pedidas, 2);
  assert.deepEqual(base.porIds.mock.calls[0].arguments[0], ['EC_1', 'CL_2']);
  assert.deepEqual(
    guardadas.map((f) => f.sourceRef),
    ['doi:10.1234/abc', 'latinoamerica:CL_2'],
  );
  // Lo de OpenAlex manda, pero su resumen vacío no borra nada.
  assert.equal(guardadas[0].title, 'Título de OpenAlex');
});

test('sin ningún id de una base conocida no se consulta nada', async () => {
  await assert.rejects(
    propiasService.importarDeExternas({ userId: 'u1', ids: ['inventada:1', '<script>'] }),
    /No marcaste ningún artículo/,
  );
});
