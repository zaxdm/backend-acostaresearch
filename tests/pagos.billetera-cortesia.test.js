'use strict';

/**
 * Billetera de cortesía (17-nov-2026, Deuna): al aprobar un pago de una
 * billetera con `cortesia`, el pago queda con importe 0 y una nota con lo que
 * valía. Una billetera sin el interruptor, o un pago sin billetera, no cambia.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const falsificar = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const BILLETERAS = {
  deuna: { pais: 'EC', cortesia: true },
  nequi: { pais: 'CO', cortesia: false },
};
const actualizados = [];
const tx = {
  billetera: { findUnique: async ({ where }) => BILLETERAS[where.id] ?? null },
  payment: { update: async (args) => actualizados.push(args) },
};

falsificar('../src/config/logger', { info() {}, warn() {}, error() {} });
falsificar('../src/lib/mailer', { sendMail: async () => {} });
falsificar('../src/lib/emailTemplates', { licenseReady: () => ({ subject: 'licencia' }) });
falsificar('../src/modules/billing/billing.service', {});
falsificar('../src/modules/billing/discount.service', {});
falsificar('../src/modules/preparar/preparar.service', {});
falsificar('../src/modules/preparar/preparar.repository', {});
falsificar('../src/modules/referidos/referidos.service', { premiarCompra: () => {} });
falsificar('../src/shared/utils/paisDelCliente', { etiquetarCliente: async () => {} });
falsificar('../src/modules/payments/payment.constancia', { tieneConstancia: () => false });
falsificar('../src/modules/licensing/license.service', {
  prepareForPurchase: async () => ({ data: { productCode: 'METODO' }, connectorUrl: 'https://mcp/x' }),
});
falsificar('../src/modules/licensing/license.repository', {
  create: async () => ({ id: 'lic-1', expiresAt: new Date() }),
});
falsificar('../src/modules/acostaia/acostaia.planes', { esPlanDeEpicuro: () => false });
falsificar('../src/modules/payments/payment.repository', {
  settle: async ({ entregar }) => (await entregar(tx)).resultado,
  findForConstancia: async () => null,
});

const { entregarPago } = require('../src/modules/payments/payment.delivery');

const pago = (extra) => ({
  id: 'pay-1',
  userId: 'u1',
  provider: 'BILLETERA',
  amountCents: 4630,
  currency: 'USD',
  reviewNote: null,
  user: { email: 'ana@gmail.com', firstName: 'Ana' },
  plan: { code: 'METODO', name: 'Método', kind: 'LICENSE', productCode: 'METODO' },
  ...extra,
});

test.beforeEach(() => {
  actualizados.length = 0;
});

test('billetera de cortesía: el pago queda en 0 con la nota de lo que valía', async () => {
  const entrega = await entregarPago({ payment: pago({ billeteraId: 'deuna' }), captura: {} });
  assert.equal(entrega.license.id, 'lic-1', 'la licencia se entrega igual');
  assert.deepEqual(actualizados, [
    { where: { id: 'pay-1' }, data: { amountCents: 0, reviewNote: 'Cortesía (antes US$ 46.30)' } },
  ]);
});

test('la nota que ya tenía el pago no se pisa', async () => {
  await entregarPago({ payment: pago({ billeteraId: 'deuna', reviewNote: 'ok' }), captura: {} });
  assert.equal(actualizados[0].data.reviewNote, 'ok · Cortesía (antes US$ 46.30)');
});

test('billetera sin el interruptor: el importe no se toca', async () => {
  await entregarPago({ payment: pago({ billeteraId: 'nequi' }), captura: {} });
  assert.equal(actualizados.length, 0);
});

test('pago sin billetera: el importe no se toca', async () => {
  await entregarPago({ payment: pago({ provider: 'YAPE', billeteraId: null }), captura: {} });
  assert.equal(actualizados.length, 0);
});
