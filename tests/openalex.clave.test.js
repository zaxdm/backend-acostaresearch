'use strict';

/**
 * La clave de OpenAlex tiene que ir en TODAS las peticiones.
 *
 * Sin clave, OpenAlex da diez centavos de presupuesto al día por IP, y todos los
 * tesistas buscan desde la misma IP del servidor: se acababa pronto y el
 * catálogo abierto quedaba «caído» hasta la medianoche UTC. Basta una consulta
 * que se olvide la clave para seguir gastando el presupuesto anónimo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const envFalso = { OPENALEX_MAILTO: 'hola@acostaresearch.com', OPENALEX_API_KEY: undefined };

const rutaEnv = require.resolve('../src/config/env');
require.cache[rutaEnv] = { id: rutaEnv, filename: rutaEnv, loaded: true, exports: envFalso };

const rutaLogger = require.resolve('../src/config/logger');
const avisos = [];
require.cache[rutaLogger] = {
  id: rutaLogger,
  filename: rutaLogger,
  loaded: true,
  exports: { info: () => {}, warn: (datos, mensaje) => avisos.push({ datos, mensaje }), error: () => {} },
};

const openalex = require('../src/modules/references/openalex.client');

function fetchFalso(t, { estado = 200 } = {}) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(new URL(String(url)));
    if (estado !== 200) {
      return { ok: false, status: estado, headers: new Map([['x-ratelimit-remaining-usd', '0']]), text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'https://openalex.org/W1', title: 'uno', results: [], meta: { count: 0 } }),
    };
  });
  return urls;
}

async function todasLasConsultas() {
  await openalex.buscar({ tema: 'comercio electrónico', cuantas: 2 });
  await openalex.porDoi('10.1000/abc');
  await openalex.referenciasDe(['10.1000/abc']);
  await openalex.porIds(['W1']);
  await openalex.citanA(['W1']);
}

test('con clave, cada consulta a OpenAlex la lleva', async (t) => {
  envFalso.OPENALEX_API_KEY = 'clave-de-prueba';
  t.after(() => {
    envFalso.OPENALEX_API_KEY = undefined;
  });
  const urls = fetchFalso(t);

  await todasLasConsultas();

  assert.ok(urls.length >= 6);
  for (const url of urls) {
    assert.equal(url.searchParams.get('api_key'), 'clave-de-prueba', url.pathname);
    assert.equal(url.searchParams.get('mailto'), 'hola@acostaresearch.com');
  }
});

test('sin clave no se manda un api_key vacío', async (t) => {
  const urls = fetchFalso(t);

  await todasLasConsultas();

  for (const url of urls) assert.equal(url.searchParams.has('api_key'), false);
});

test('un 429 queda en el registro como presupuesto agotado, sin la clave', async (t) => {
  envFalso.OPENALEX_API_KEY = 'secreta';
  t.after(() => {
    envFalso.OPENALEX_API_KEY = undefined;
  });
  fetchFalso(t, { estado: 429 });
  avisos.length = 0;

  const resultado = await openalex.buscar({ tema: 'lo que sea', cuantas: 2 });

  assert.equal(resultado.caida, true);
  assert.ok(avisos.some((a) => a.mensaje === 'OpenAlex: presupuesto diario agotado'));
  assert.ok(!JSON.stringify(avisos).includes('secreta'));
});
