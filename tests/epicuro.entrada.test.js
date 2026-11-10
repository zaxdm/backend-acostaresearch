'use strict';

/**
 * «Abrir Epicuro.ai» (11-nov-2026): el pase lleva quién es, el método y la
 * frase; Epicuro lo puede comprobar con la clave compartida; vence en 2 minutos
 * y cada pase es distinto (para que Epicuro no acepte uno repetido).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const CLAVE = 'k'.repeat(40);
const ENV = { ACOSTAIA_CLAVE_INTERNA: CLAVE, EPICURO_WEB_URL: 'https://epicuro.prueba/' };
sustituir('../src/config/env', ENV);
sustituir('../src/lib/prisma', {
  user: { findUnique: async () => ({ email: 'Ana@Gmail.com', firstName: 'Ana', lastName: 'Pérez' }) },
});

const entrada = require('../src/modules/epicuro/epicuro.entrada');

function leer(url) {
  const token = url.split('#t=')[1];
  const [cuerpo, firma] = token.split('.');
  assert.equal(firma, crypto.createHmac('sha256', CLAVE).update(cuerpo).digest('base64url'), 'firma válida');
  return JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
}

test('el pase lleva quién es, el método y la frase, y va en el # de epicuro.ai', async () => {
  const { url } = await entrada.pase({
    userId: 'u1',
    productCode: 'METODO_TESIS',
    frase: 'Usa el conector de Acosta Research: llama a «continuar» y sigamos con «1 · Tema».',
  });
  assert.match(url, /^https:\/\/epicuro\.prueba\/desde-acosta#t=/);
  const d = leer(url);
  assert.equal(d.email, 'ana@gmail.com');
  assert.equal(d.nombre, 'Ana');
  assert.equal(d.productCode, 'METODO_TESIS');
  assert.match(d.frase, /sigamos con «1 · Tema»/);
  assert.ok(d.exp - Date.now() <= 2 * 60 * 1000 && d.exp > Date.now());
});

test('cada pase es distinto', async () => {
  const a = leer((await entrada.pase({ userId: 'u1' })).url);
  const b = leer((await entrada.pase({ userId: 'u1' })).url);
  assert.notEqual(a.n, b.n);
  assert.equal(a.productCode, undefined);
});

test('sin la clave compartida no hay pase', async () => {
  ENV.ACOSTAIA_CLAVE_INTERNA = undefined;
  await assert.rejects(entrada.pase({ userId: 'u1' }), (e) => e.statusCode === 503);
  ENV.ACOSTAIA_CLAVE_INTERNA = CLAVE;
});
