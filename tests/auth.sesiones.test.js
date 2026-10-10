'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let cuenta, payload;
const prisma = require.resolve('../src/lib/prisma');
require.cache[prisma] = { id: prisma, filename: prisma, loaded: true,
  exports: { user: { findUnique: async () => cuenta } } };
const tokens = require.resolve('../src/shared/utils/tokens');
require.cache[tokens] = { id: tokens, filename: tokens, loaded: true,
  exports: { verifyAccessToken: () => payload } };
const authenticate = require('../src/middlewares/authenticate');
const comprobar = async () => {
  const req = { get: () => 'Bearer firmado' };
  let fallo;
  await authenticate(req, {}, error => { fallo = error; });
  return { fallo, req };
};
test.beforeEach(() => {
  cuenta = { id: 'u', role: 'USER', email: 'ana@example.com', status: 'ACTIVE', sessionVersion: 0 };
  payload = { sub: 'u', role: 'USER', typ: 'access', sessionVersion: 0 };
});
test('una cuenta suspendida no entra con un token todavía vigente', async () => {
  cuenta.status = 'SUSPENDED';
  assert.equal((await comprobar()).fallo.statusCode, 403);
});
test('reactivar la cuenta no recupera sesiones de la versión anterior', async () => {
  cuenta.sessionVersion = 2;
  assert.equal((await comprobar()).fallo.statusCode, 401);
});
test('un cambio de rol rechaza las credenciales del rol anterior', async () => {
  cuenta.role = 'ADMIN';
  assert.equal((await comprobar()).fallo.statusCode, 401);
});
test('la sesión actual toma el correo vigente de la cuenta', async () => {
  const { fallo, req } = await comprobar();
  assert.equal(fallo, undefined);
  assert.equal(req.user.email, cuenta.email);
});
