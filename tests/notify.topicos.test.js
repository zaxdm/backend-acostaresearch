'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Los dos tópicos de ntfy: al administrador solo le llega lo suyo, al
 * programador todo.
 *
 * El 1 de octubre de 2026 el administrador recibía en el móvil los errores del
 * backend y los respaldos junto a los Yape, y lo técnico tapaba lo que él tenía
 * que atender. Se prueba a qué tópico va cada aviso, y que sin el del
 * programador lo técnico no se pierde.
 *
 * `env` y el logger se sustituyen, y `fetch` se intercepta: no sale nada a la red.
 */

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const env = { NTFY_URL: 'https://ntfy.sh', NTFY_TOPIC: 'admin', NTFY_TOPIC_PROGRAMADOR: 'programador' };
sustituir('../src/config/env', env);
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

let enviados = [];
global.fetch = async (_url, { body }) => {
  enviados.push(JSON.parse(body).topic);
  return { ok: true };
};

const { avisarAlAdmin, avisarAlProgramador } = require('../src/lib/notify');
const aviso = { titulo: 't', mensaje: 'm' };

test.beforeEach(() => {
  enviados = [];
  env.NTFY_TOPIC = 'admin';
  env.NTFY_TOPIC_PROGRAMADOR = 'programador';
});

test('lo del administrador llega a los dos tópicos', () => {
  avisarAlAdmin(aviso);
  assert.deepEqual(enviados.sort(), ['admin', 'programador']);
});

test('lo técnico llega solo al programador', () => {
  avisarAlProgramador(aviso);
  assert.deepEqual(enviados, ['programador']);
});

test('sin tópico del programador, lo técnico sigue yendo al de siempre', () => {
  env.NTFY_TOPIC_PROGRAMADOR = undefined;
  avisarAlProgramador(aviso);
  avisarAlAdmin(aviso);
  assert.deepEqual(enviados, ['admin', 'admin']);
});

test('con los dos tópicos iguales no se manda dos veces', () => {
  env.NTFY_TOPIC_PROGRAMADOR = 'admin';
  avisarAlAdmin(aviso);
  assert.deepEqual(enviados, ['admin']);
});

test('sin ningún tópico no se llama a la red', () => {
  env.NTFY_TOPIC = undefined;
  env.NTFY_TOPIC_PROGRAMADOR = undefined;
  avisarAlAdmin(aviso);
  avisarAlProgramador(aviso);
  assert.deepEqual(enviados, []);
});
