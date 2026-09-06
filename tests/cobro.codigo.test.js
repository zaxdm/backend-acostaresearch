'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pagoDelCodigo } = require('../src/modules/licensing/license.service');

/**
 * Lo que se prueba aquí es dinero.
 *
 * Un código de activación se reparte por dos motivos que se parecen mucho por
 * fuera —una venta cobrada fuera de la web y una cortesía— y entregan
 * exactamente lo mismo. La única diferencia vive en esta función, y equivocarla
 * tiene consecuencias en las dos direcciones: una venta que no se apunta
 * desaparece de las cuentas, y un regalo apuntado como cobro infla los ingresos
 * con dinero que nunca entró.
 */

const CONTRATO = { planId: 'plan-metodo', priceCents: 29700, nombre: 'Método · 9 Skills' };
const USUARIO = 'usuario-1';

function codigo(extra = {}) {
  return {
    id: 'codigo-1',
    hint: 'K7P2',
    productCode: 'METODO_9_SKILLS',
    buyerEmail: 'ana@example.com',
    note: 'Western Union 5 sep',
    createdById: 'admin-1',
    createdAt: new Date('2026-09-05T12:00:00Z'),
    paymentMethod: 'WESTERN_UNION',
    paymentRef: 'MTCN-8891',
    amountCents: 25000,
    ...extra,
  };
}

test('una venta cobrada fuera de la web se apunta como pago cobrado', () => {
  const pago = pagoDelCodigo({ registro: codigo(), contrato: CONTRATO, userId: USUARIO });

  assert.equal(pago.status, 'PAID');
  assert.equal(pago.amountCents, 25000);
  assert.equal(pago.currency, 'PEN');
  assert.equal(pago.provider, 'WESTERN_UNION');
  assert.equal(pago.userId, USUARIO);
  assert.equal(pago.planId, CONTRATO.planId);
  // El nº de operación es lo que permite cuadrarlo con el extracto.
  assert.equal(pago.operationCode, 'MTCN-8891');
  assert.ok(pago.paidAt instanceof Date);
});

test('una cortesía no apunta ningún cobro', () => {
  const pago = pagoDelCodigo({
    registro: codigo({ paymentMethod: 'CORTESIA', amountCents: null }),
    contrato: CONTRATO,
    userId: USUARIO,
  });

  assert.equal(pago, null);
});

test('un código de los antiguos, sin cobro apuntado, tampoco inventa uno', () => {
  const pago = pagoDelCodigo({
    registro: codigo({ paymentMethod: null, paymentRef: null, amountCents: null }),
    contrato: CONTRATO,
    userId: USUARIO,
  });

  assert.equal(pago, null);
});

test('sin importe apuntado se cobra el precio del plan', () => {
  const pago = pagoDelCodigo({
    registro: codigo({ amountCents: null }),
    contrato: CONTRATO,
    userId: USUARIO,
  });

  assert.equal(pago.amountCents, CONTRATO.priceCents);
});

test('un importe de cero no se apunta: sería una venta de nada', () => {
  const pago = pagoDelCodigo({
    registro: codigo({ amountCents: 0 }),
    contrato: CONTRATO,
    userId: USUARIO,
  });

  assert.equal(pago, null);
});

test('un producto sin plan activo no puede apuntar el cobro', () => {
  const pago = pagoDelCodigo({
    registro: codigo(),
    contrato: { planId: null, priceCents: 0, nombre: 'Método de tesis' },
    userId: USUARIO,
  });

  assert.equal(pago, null);
});

test('la referencia del pago es el propio código, que es único', () => {
  const pago = pagoDelCodigo({ registro: codigo(), contrato: CONTRATO, userId: USUARIO });

  // La pareja (provider, providerOrderId) es única en la tabla: es lo que
  // impide que un mismo código llegue a apuntar dos cobros.
  assert.equal(pago.providerOrderId, 'codigo-1');
});

test('sin nº de operación la referencia del cobro no queda vacía', () => {
  const pago = pagoDelCodigo({
    registro: codigo({ paymentRef: null }),
    contrato: CONTRATO,
    userId: USUARIO,
  });

  assert.equal(pago.providerCaptureId, 'codigo-1');
});
