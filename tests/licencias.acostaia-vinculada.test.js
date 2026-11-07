'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * El conector de AcostaIA atado a una compra (7-nov-2026) vale lo que valga la
 * comprada, en cada llamada: si se revoca o caduca, deja de entrar; si sigue
 * bien, entra con la caducidad y los topes de la comprada. Una licencia normal
 * no cambia. La base y el repositorio se sustituyen.
 */

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { licencia: null, comprada: null };

sustituir('../src/lib/prisma', {
  license: { findUnique: async () => estado.comprada && { ...estado.comprada } },
});
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });
sustituir('../src/modules/licensing/license.repository', {
  findByTokenHash: async () => estado.licencia && { ...estado.licencia },
});

const licenseService = require('../src/modules/licensing/license.service');

const usuario = { id: 'U1', status: 'ACTIVE', trialLink: null };

function empezar(comprada = {}) {
  estado.licencia = {
    id: 'aia',
    status: 'ACTIVE',
    expiresAt: null,
    acostaiaDeId: 'comprada',
    callsPerDay: 0,
    costCentsPerMonth: 0,
    user: usuario,
  };
  estado.comprada = {
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 86_400_000),
    callsPerDay: 40,
    callsPerMonth: 0,
    costCentsPerMonth: 900,
    callsLimitTotal: 0,
    costCentsLimitTotal: 0,
    delivery: 'EXECUTED',
    variasTesis: true,
    ...comprada,
  };
}

test('entra con la caducidad y los topes de la comprada', async () => {
  empezar();
  const l = await licenseService.authenticate('token-de-aia');
  assert.equal(l.id, 'aia');
  assert.equal(l.acostaiaDeId, 'comprada');
  assert.equal(l.callsPerDay, 40);
  assert.equal(l.costCentsPerMonth, 900);
  assert.equal(l.variasTesis, true);
  assert.deepEqual(l.expiresAt, estado.comprada.expiresAt);
  assert.equal(l.status, 'ACTIVE');
});

test('si la comprada se revoca, el de AcostaIA deja de entrar', async () => {
  empezar({ status: 'REVOKED' });
  await assert.rejects(licenseService.authenticate('token-de-aia'), /está desactivado/);
});

test('si la comprada caduca, el de AcostaIA deja de entrar', async () => {
  empezar({ expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(licenseService.authenticate('token-de-aia'), /caducó\. Renuévalo/);
});

test('una licencia normal no mira ninguna otra', async () => {
  empezar();
  estado.licencia.acostaiaDeId = null;
  estado.comprada = null;
  const l = await licenseService.authenticate('token-normal');
  assert.equal(l.callsPerDay, 0);
});
