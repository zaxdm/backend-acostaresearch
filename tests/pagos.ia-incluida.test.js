'use strict';

/**
 * Plan de tesis + IA (10-nov-2026): la oferta de S/159 entrega la licencia de
 * 1 año Y el primer mes de IA (`incluyeEpicuro`), dentro de la misma
 * transacción del cobro. Un plan sin el campo entrega solo la licencia, como
 * siempre, y un código que no es de Epicuro no entrega nada extra.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const falsificar = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const entregasIa = [];
const correos = [];
const PLANES = {
  EPICURO_ESTANDAR: { code: 'EPICURO_ESTANDAR', kind: 'EPICURO', productCode: 'ESTANDAR', durationDays: 30 },
  OTRO_LICENSE: { code: 'OTRO_LICENSE', kind: 'LICENSE' },
};
const tx = {
  plan: { findUnique: async ({ where }) => PLANES[where.code] ?? null },
};

falsificar('../src/config/logger', { info() {}, warn() {}, error() {} });
falsificar('../src/lib/mailer', { sendMail: async (m) => correos.push(m.subject) });
falsificar('../src/lib/emailTemplates', {
  licenseReady: () => ({ subject: 'licencia' }),
  licenseRenewed: () => ({ subject: 'renovada' }),
  epicuroReady: () => ({ subject: 'ia' }),
});
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
falsificar('../src/modules/acostaia/acostaia.planes', {
  esPlanDeEpicuro: (plan) => plan?.kind === 'EPICURO',
  entregar: async ({ userId, plan }) => {
    entregasIa.push({ userId, plan: plan.code });
    return { nivel: plan.productCode, expiresAt: new Date(), renovada: false };
  },
});
falsificar('../src/modules/payments/payment.repository', {
  settle: async ({ entregar }) => (await entregar(tx)).resultado,
  findForConstancia: async () => null,
});

const { entregarPago } = require('../src/modules/payments/payment.delivery');

const pago = (plan) => ({
  id: 'pay-1',
  userId: 'u1',
  provider: 'CULQI',
  user: { email: 'ana@gmail.com', firstName: 'Ana' },
  plan: { code: 'TESIS_IA', name: 'Tesis + IA', kind: 'LICENSE', productCode: 'METODO', ...plan },
});

test.beforeEach(() => {
  entregasIa.length = 0;
  correos.length = 0;
});

test('la oferta entrega la licencia y además el primer mes de IA', async () => {
  const entrega = await entregarPago({ payment: pago({ incluyeEpicuro: 'EPICURO_ESTANDAR' }), captura: {} });
  assert.equal(entrega.license.id, 'lic-1');
  assert.equal(entrega.epicuro.nivel, 'ESTANDAR');
  assert.deepEqual(entregasIa, [{ userId: 'u1', plan: 'EPICURO_ESTANDAR' }]);
  await new Promise((r) => setImmediate(r));
  assert.ok(correos.includes('ia'), 'sale el correo de la IA incluida');
});

test('sin el campo, solo la licencia, como siempre', async () => {
  const entrega = await entregarPago({ payment: pago({}), captura: {} });
  assert.equal(entrega.license.id, 'lic-1');
  assert.equal(entrega.epicuro, undefined);
  assert.equal(entregasIa.length, 0);
});

test('un código que no es de Epicuro no entrega nada extra', async () => {
  const entrega = await entregarPago({ payment: pago({ incluyeEpicuro: 'OTRO_LICENSE' }), captura: {} });
  assert.equal(entrega.epicuro, undefined);
  assert.equal(entregasIa.length, 0);
});
