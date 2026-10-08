'use strict';

/**
 * ALICIA tiene ratos malos de un minuto. Lo que tiene que ser cierto:
 *
 *   · Un fallo pasajero (sin respuesta a tiempo, 5xx, página HTML en vez de
 *     JSON) se repite una vez, y si la segunda va bien el tesista ni se entera.
 *   · Si la segunda también falla, el error llega como antes.
 *   · Un 4xx no se repite: la misma pregunta daría lo mismo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { pedir } = require('../src/modules/references/alicia.client');

const fetchOriginal = global.fetch;
test.afterEach(() => {
  global.fetch = fetchOriginal;
});

const respuesta = (status, cuerpo) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof cuerpo === 'string' ? JSON.parse(cuerpo) : cuerpo),
});

/** Un fetch que contesta, por turnos, lo que se le pase. */
function fetchPorTurnos(...turnos) {
  const llamadas = [];
  global.fetch = async (url) => {
    llamadas.push(String(url));
    const turno = turnos[llamadas.length - 1];
    if (turno instanceof Error) throw turno;
    return turno;
  };
  return llamadas;
}

const SIN_PAUSA = { pausaMs: 0 };

test('sin respuesta a tiempo: reintenta y devuelve la segunda', async () => {
  const llamadas = fetchPorTurnos(
    new Error('The operation was aborted due to timeout'),
    respuesta(200, { status: 'OK', resultCount: 3 }),
  );
  const json = await pedir('/search', [['lookfor', 'tesis']], SIN_PAUSA);
  assert.equal(json.resultCount, 3);
  assert.equal(llamadas.length, 2);
});

test('una página HTML en vez de JSON también se reintenta', async () => {
  const llamadas = fetchPorTurnos(
    respuesta(200, 'Connection refused'),
    respuesta(200, { status: 'OK', resultCount: 1 }),
  );
  const json = await pedir('/search', [], SIN_PAUSA);
  assert.equal(json.resultCount, 1);
  assert.equal(llamadas.length, 2);
});

test('un 503 se reintenta; si vuelve a fallar, el error llega', async () => {
  const llamadas = fetchPorTurnos(respuesta(503, {}), respuesta(503, {}));
  await assert.rejects(pedir('/search', [], SIN_PAUSA), /ALICIA respondió 503/);
  assert.equal(llamadas.length, 2);
});

test('un 400 no se reintenta', async () => {
  const llamadas = fetchPorTurnos(respuesta(400, {}));
  await assert.rejects(pedir('/search', [], SIN_PAUSA), /ALICIA respondió 400/);
  assert.equal(llamadas.length, 1);
});
