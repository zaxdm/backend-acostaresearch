'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let licencias = [];
const ruta = require.resolve('../src/modules/licensing/license.repository');
require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports: { listForUser: async () => licencias } };
const { comprobarRenovacion } = require('../src/modules/payments/payment.renovacion');
const plan = { kind: 'LICENSE', productCode: 'TESIS' };
const ahora = new Date('2026-10-10T12:00:00Z');
test.beforeEach(() => { licencias = []; });
test('antes de los últimos 30 días se rechaza la compra', async () => {
  licencias = [{ productCode: 'TESIS', status: 'ACTIVE', expiresAt: '2026-11-10T12:00:00Z' }];
  await assert.rejects(comprobarRenovacion('u', plan, ahora), e => e.statusCode === 409);
});
test('el límite exacto de 30 días y una licencia vencida permiten renovar', async () => {
  for (const expiresAt of ['2026-11-09T12:00:00Z', '2026-10-01T12:00:00Z']) {
    licencias = [{ productCode: 'TESIS', status: 'ACTIVE', expiresAt }];
    await comprobarRenovacion('u', plan, ahora);
  }
});
test('una licencia permanente impide comprar otra del mismo producto', async () => {
  licencias = [{ productCode: 'TESIS', status: 'ACTIVE', expiresAt: null }];
  await assert.rejects(comprobarRenovacion('u', plan, ahora));
});
test('licencias revocadas y de otro producto no impiden comprar', async () => {
  licencias = [{ productCode: 'TESIS', status: 'REVOKED', expiresAt: null },
    { productCode: 'OTRO', status: 'ACTIVE', expiresAt: null }];
  await comprobarRenovacion('u', plan, ahora);
});
