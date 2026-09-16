'use strict';

/**
 * La búsqueda abierta tiene respaldo: si OpenAlex no contesta, Crossref.
 *
 * El 16 de septiembre de 2026 OpenAlex se quedó sin presupuesto y el conector
 * pasó el día diciendo que el catálogo no respondía. Se prueba que se salta a
 * Crossref SOLO cuando OpenAlex cae, y que se avisa de los filtros que Crossref
 * no sabe aplicar: una lista sin acotar no puede presentarse como peruana.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });
sustituir('../src/modules/references/zotero.client', {});
sustituir('../src/modules/references/reference.repository', {});

const respuestas = { openalex: null, crossref: null };
const pedidas = [];
sustituir('../src/modules/references/openalex.client', {
  buscar: async (consulta) => {
    pedidas.push(['openalex', consulta]);
    return respuestas.openalex;
  },
});
sustituir('../src/modules/references/crossref.client', {
  buscar: async (consulta) => {
    pedidas.push(['crossref', consulta]);
    return respuestas.crossref;
  },
});

const referenceService = require('../src/modules/references/reference.service');

const fuente = (titulo) => ({
  titulo,
  autores: 'Quispe, A.',
  anio: 2022,
  revista: 'Revista',
  doi: '10.1000/x',
  citas: 0,
  idioma: null,
  pdfLibre: null,
  resumen: null,
});

test.beforeEach(() => {
  pedidas.length = 0;
});

test('con OpenAlex respondiendo, Crossref ni se pregunta', async () => {
  respuestas.openalex = { fuentes: [fuente('de OpenAlex')], total: 1, caida: false };

  const r = await referenceService.buscarEnLaLiteratura({ tema: 'clima laboral', pais: 'pe' });

  assert.equal(r.origen, 'openalex');
  assert.deepEqual(r.filtrosSinAplicar, []);
  assert.deepEqual(pedidas.map(([quien]) => quien), ['openalex']);
});

test('si OpenAlex cae, busca en Crossref y dice qué filtros no aplicó', async () => {
  respuestas.openalex = { fuentes: [], total: 0, caida: true };
  respuestas.crossref = { fuentes: [fuente('de Crossref')], total: 40, caida: false };

  const r = await referenceService.buscarEnLaLiteratura({
    tema: 'clima laboral',
    pais: 'pe',
    idioma: 'es',
    desdeAnio: 2020,
  });

  assert.equal(r.caida, false);
  assert.equal(r.origen, 'crossref');
  assert.deepEqual(r.filtrosSinAplicar, ['país pe', 'idioma es']);
  assert.equal(r.fuentes[0].titulo, 'de Crossref');
  assert.ok(r.fuentes[0].cita, 'la cita se arma igual que con OpenAlex');
  assert.equal(pedidas[1][1].desdeAnio, 2020, 'el año sí lo sabe filtrar');
});

test('si caen los dos, se dice caída', async () => {
  respuestas.openalex = { fuentes: [], total: 0, caida: true };
  respuestas.crossref = { fuentes: [], total: 0, caida: true };

  const r = await referenceService.buscarEnLaLiteratura({ tema: 'clima laboral' });

  assert.equal(r.caida, true);
  assert.deepEqual(r.fuentes, []);
});
