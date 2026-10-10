'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
let stored, rotated, revoked;
function mock(ruta, exports) {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
mock('../src/config/env', {
  JWT_REFRESH_TTL_DAYS: 30, JWT_ACCESS_SECRET: 'x'.repeat(32), JWT_ACCESS_TTL: '15m',
  JWT_ISSUER: 'acosta-test', JWT_AUDIENCE: 'acosta-test',
});
mock('../src/config/logger', { info() {}, warn() {}, error() {} });
mock('../src/modules/users/user.repository', {});
mock('../src/modules/auth/pendingRegistration.repository', {});
mock('../src/modules/auth/google.verifier', {});
mock('../src/modules/billing/billing.service', {});
mock('../src/lib/mailer', {});
mock('../src/modules/auth/token.repository', {
  findRefreshByHash: async () => stored,
  revokeAllForUser: async id => { revoked = id; },
  rotate: async (id, data) => { rotated = data; },
});
const auth = require('../src/modules/auth/auth.service');
const { verifyAccessToken } = require('../src/shared/utils/tokens');
test.beforeEach(() => {
  rotated = undefined;
  revoked = undefined;
  stored = { id: 'r', userId: 'u', familyId: 'f', sessionVersion: 3,
    expiresAt: new Date(Date.now() + 60000),
    user: { id: 'u', email: 'ana@example.com', role: 'USER', status: 'ACTIVE', sessionVersion: 3 } };
});
test('una suspension impide renovar y revoca las sesiones guardadas', async () => {
  stored.user.status = 'SUSPENDED';
  await assert.rejects(auth.refresh('token'), e => e.statusCode === 403);
  assert.equal(revoked, 'u');
  assert.equal(rotated, undefined);
});
test('reactivar o restaurar el rol no permite renovar con la version anterior', async () => {
  stored.user.sessionVersion = 5;
  await assert.rejects(auth.refresh('token'), e => e.statusCode === 401);
  assert.equal(revoked, 'u');
  assert.equal(rotated, undefined);
});
test('una sesion vigente conserva la version al rotar ambos tokens', async () => {
  const resultado = await auth.refresh('token');
  assert.equal(rotated.sessionVersion, 3);
  assert.equal(rotated.familyId, 'f');
  assert.equal(verifyAccessToken(resultado.accessToken).sessionVersion, 3);
  assert.equal(revoked, undefined);
});
