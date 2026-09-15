'use strict';

/**
 * De qué IP se cuenta cada petición en los límites.
 *
 * La web llega por el Worker de Cloudflare, y para el backend esa IP es la de
 * Cloudflare, la misma para muchos visitantes. El Worker manda la del visitante
 * con un secreto. Lo que se prueba: que con el secreto se usa la del visitante,
 * y que SIN él —quien llama directo a la API— la cabecera no sirve para elegir.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SECRETO = 's'.repeat(40);
const rutaEnv = require.resolve(path.join(__dirname, '../src/config/env'));
require.cache[rutaEnv] = { id: rutaEnv, filename: rutaEnv, loaded: true, exports: { PROXY_SECRET: SECRETO } };

const { ipCliente } = require('../src/shared/utils/ipCliente');

function peticion(cabeceras, ip = '104.28.1.1') {
  const minusculas = Object.fromEntries(Object.entries(cabeceras).map(([k, v]) => [k.toLowerCase(), v]));
  return { ip, get: (nombre) => minusculas[nombre.toLowerCase()] };
}

test('con el secreto del Worker, cuenta la IP del visitante', () => {
  const req = peticion({ 'X-Acosta-Proxy': SECRETO, 'X-Cliente-IP': '190.235.10.20' });
  assert.equal(ipCliente(req), '190.235.10.20');
});

test('también con IPv6', () => {
  const req = peticion({ 'X-Acosta-Proxy': SECRETO, 'X-Cliente-IP': '2800:200:e840::1' });
  assert.equal(ipCliente(req), '2800:200:e840::1');
});

test('sin el secreto, o con otro, la cabecera no sirve para elegir IP', () => {
  assert.equal(ipCliente(peticion({ 'X-Cliente-IP': '1.2.3.4' })), '104.28.1.1');
  assert.equal(ipCliente(peticion({ 'X-Acosta-Proxy': 'otro', 'X-Cliente-IP': '1.2.3.4' })), '104.28.1.1');
  assert.equal(ipCliente(peticion({ 'X-Acosta-Proxy': `${SECRETO}x`, 'X-Cliente-IP': '1.2.3.4' })), '104.28.1.1');
});

test('con el secreto pero sin una IP válida, se queda la de la conexión', () => {
  assert.equal(ipCliente(peticion({ 'X-Acosta-Proxy': SECRETO, 'X-Cliente-IP': 'no-es-ip' })), '104.28.1.1');
  assert.equal(ipCliente(peticion({ 'X-Acosta-Proxy': SECRETO })), '104.28.1.1');
});
