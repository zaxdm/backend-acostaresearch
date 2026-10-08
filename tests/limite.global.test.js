'use strict';

/**
 * Cómo cuenta el límite general de la API (8-oct-2026).
 *
 * Con sesión, por persona: treinta alumnos en la misma wifi no comparten cupo.
 * Sin sesión —o con un token caducado o falso—, por IP. Un token falso no le
 * sirve a nadie para fabricarse cubos nuevos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const ENV = {
  isDevelopment: false,
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_ACCESS_TTL: '15m',
  JWT_ISSUER: 'acosta',
  JWT_AUDIENCE: 'web',
};
const rutaEnv = require.resolve(path.join(__dirname, '../src/config/env'));
require.cache[rutaEnv] = { id: rutaEnv, filename: rutaEnv, loaded: true, exports: ENV };

const { porSesionOIp } = require('../src/middlewares/rateLimit');
const { signAccessToken } = require('../src/shared/utils/tokens');

function peticion(authorization, ip = '190.235.10.20') {
  return { ip, get: (nombre) => (nombre.toLowerCase() === 'authorization' ? authorization : undefined) };
}

test('con sesión cuenta por persona, aunque compartan IP', () => {
  const a = signAccessToken({ userId: 'u1', role: 'USER', email: 'a@x.pe' });
  const b = signAccessToken({ userId: 'u2', role: 'USER', email: 'b@x.pe' });
  assert.equal(porSesionOIp(peticion(`Bearer ${a}`)), 'usuario:u1');
  assert.equal(porSesionOIp(peticion(`Bearer ${b}`)), 'usuario:u2');
});

test('sin sesión cuenta por IP', () => {
  assert.equal(porSesionOIp(peticion(undefined)), '190.235.10.20');
  assert.equal(porSesionOIp(peticion('Basic abc')), '190.235.10.20');
});

test('un token falso, caducado o que no es de acceso cuenta por IP', () => {
  const falso = jwt.sign({ typ: 'access' }, 'otra-clave', { subject: 'u9', issuer: 'acosta', audience: 'web' });
  const caducado = jwt.sign({ typ: 'access' }, ENV.JWT_ACCESS_SECRET, {
    subject: 'u1', issuer: 'acosta', audience: 'web', expiresIn: -10,
  });
  const otroTipo = jwt.sign({ typ: 'refresh' }, ENV.JWT_ACCESS_SECRET, { subject: 'u1', issuer: 'acosta', audience: 'web' });
  for (const t of [falso, caducado, otroTipo, 'basura']) {
    assert.equal(porSesionOIp(peticion(`Bearer ${t}`)), '190.235.10.20');
  }
});
