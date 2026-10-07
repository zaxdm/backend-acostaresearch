'use strict';

/**
 * Hotmart: el pago lo confirma su webhook, no el navegador.
 *
 * Lo que se fija aquí:
 *  - que solo se acepta el aviso firmado con el Hottok;
 *  - que el `sck` del enlace de pago encuentra la orden que abrió la web;
 *  - que un aviso repetido (o el COMPLETE tras el APPROVED) no entrega dos veces;
 *  - que quien paga desde un enlace compartido recibe lo suyo en su cuenta, o
 *    en una nueva si no tenía;
 *  - que un reembolso no quita nada solo: lo anota y avisa.
 *
 * La base es falsa: los repositorios se cargan en `require.cache` antes que el
 * webhook.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

const HOTTOK = 'hottok-de-prueba-123456';

const PLAN = { id: 'plan-tesis', code: 'METODO_DE_TESIS_HUMANIZADOR', name: 'Método de Tesis', priceCents: 15900, kind: 'LICENSE', durationDays: 360 };
const DIA = 24 * 60 * 60 * 1000;

const pagos = new Map();
const usuarios = new Map();
const licencias = new Map();
const llamadas = { entregas: [], devoluciones: [], fallos: [], avisos: [], cuentas: [], revocadas: [], acortadas: [] };

falsificar('../src/config/env', { hotmartEnabled: true, HOTMART_HOTTOK: HOTTOK });
falsificar('../src/config/logger', { info() {}, warn() {}, error() {} });
falsificar('../src/lib/notify', { avisarAlAdmin: (aviso) => llamadas.avisos.push(aviso) });
falsificar('../src/modules/licensing/license.repository', {
  findById: async (id) => licencias.get(id) ?? null,
  acortar: async (id, expiresAt) => {
    llamadas.acortadas.push({ id, expiresAt });
    licencias.get(id).expiresAt = expiresAt;
  },
});
falsificar('../src/modules/licensing/license.service', {
  revoke: async (id, motivo) => {
    llamadas.revocadas.push({ id, motivo });
    licencias.get(id).status = 'REVOKED';
  },
});
falsificar('../src/modules/billing/billing.repository', {
  findPlanByCode: async (code) => (code === PLAN.code ? PLAN : null),
});
falsificar('../src/modules/users/user.repository', {
  findByEmail: async (email) => usuarios.get(email) ?? null,
  create: async (data) => {
    const user = { id: `user-${usuarios.size + 1}`, ...data };
    usuarios.set(data.email, user);
    llamadas.cuentas.push(user);
    return user;
  },
});

function conRelaciones(pago) {
  if (!pago) return null;
  const user = [...usuarios.values()].find((u) => u.id === pago.userId) ?? null;
  return { ...pago, plan: PLAN, user };
}

falsificar('../src/modules/payments/payment.repository', {
  findByOrderId: async (provider, orderId) =>
    conRelaciones([...pagos.values()].find((p) => p.provider === provider && p.providerOrderId === orderId)),
  findByCaptureId: async (provider, captureId) =>
    conRelaciones([...pagos.values()].find((p) => p.provider === provider && p.providerCaptureId === captureId)),
  create: async (data) => {
    const pago = { id: `pago-${pagos.size + 1}`, status: 'PENDING', ...data };
    pagos.set(pago.id, pago);
    return pago;
  },
  marcarDevolucion: async (id, datos) => {
    llamadas.devoluciones.push({ id, ...datos });
    pagos.get(id).errorCode = datos.errorCode;
  },
  fail: async (id, datos) => {
    llamadas.fallos.push({ id, ...datos });
    pagos.get(id).status = 'FAILED';
  },
});
falsificar('../src/modules/payments/payment.delivery', {
  entregarPago: async ({ payment, captura, estadoEsperado }) => {
    const fila = pagos.get(payment.id);
    if (fila.status !== estadoEsperado) return null;
    llamadas.entregas.push({ payment, captura, estadoEsperado });
    const ahora = new Date();
    // Renovación si ya tenía licencia; compra nueva si no.
    if (!licencias.has('lic-1')) {
      licencias.set('lic-1', { id: 'lic-1', status: 'ACTIVE', createdAt: ahora, expiresAt: new Date(ahora.getTime() + 360 * DIA) });
    } else {
      const lic = licencias.get('lic-1');
      lic.expiresAt = new Date(lic.expiresAt.getTime() + 360 * DIA);
    }
    Object.assign(fila, { status: 'PAID', providerCaptureId: captura.captureId, paidAt: ahora, licenseId: 'lic-1' });
    return { license: { id: 'lic-1' } };
  },
});

const webhook = require('../src/modules/payments/hotmart.webhook');
const { hotmartProvider } = require('../src/modules/payments/providers/hotmart.provider');

function aviso(evento, { sck, transaccion = 'HP123', productId = 8674715, email = 'rosa@gmail.com', precio } = {}) {
  return {
    event: evento,
    version: '2.0.0',
    data: {
      product: { id: productId, name: 'Método de Tesis' },
      buyer: { email, name: 'Rosa Tecocha Díaz' },
      purchase: {
        transaction: transaccion,
        status: 'APPROVED',
        origin: sck ? { sck } : {},
        original_offer_price: precio ?? { value: 170, currency_value: 'PEN' },
        price: { value: 170, currency_value: 'PEN' },
      },
    },
  };
}

test.beforeEach(() => {
  pagos.clear();
  usuarios.clear();
  licencias.clear();
  for (const lista of Object.values(llamadas)) lista.length = 0;
});

test('solo se acepta el aviso con el Hottok exacto', () => {
  assert.equal(webhook.firmaValida(HOTTOK), true);
  assert.equal(webhook.firmaValida('otro'), false);
  assert.equal(webhook.firmaValida(`${HOTTOK}x`), false);
  assert.equal(webhook.firmaValida(undefined), false);
});

test('el enlace de pago lleva nuestra referencia en sck, y solo para planes enlazados', async () => {
  const orden = await hotmartProvider.createOrder({ plan: PLAN });
  assert.match(orden.orderId, /^hm_/);
  assert.equal(orden.approveUrl, `https://pay.hotmart.com/S107921285K?sck=${orden.orderId}`);
  assert.equal(hotmartProvider.priceForPlan(PLAN), 15900);
  assert.equal(hotmartProvider.priceForPlan({ code: 'OTRO', priceCents: 100 }), null);
});

test('compra que sale de la web: el sck encuentra la orden y se entrega con lo cobrado', async () => {
  usuarios.set('ana@gmail.com', { id: 'user-ana', email: 'ana@gmail.com', firstName: 'Ana' });
  pagos.set('pago-web', {
    id: 'pago-web', userId: 'user-ana', provider: 'HOTMART', providerOrderId: 'hm_abc', status: 'PENDING',
  });

  const r = await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { sck: 'hm_abc', email: 'otro@correo.com' }));

  assert.equal(r.resultado, 'entregado');
  assert.equal(llamadas.entregas.length, 1);
  assert.equal(llamadas.entregas[0].payment.userId, 'user-ana');
  assert.equal(llamadas.entregas[0].captura.captureId, 'HP123');
  assert.deepEqual(llamadas.entregas[0].captura.importeReal, { amountCents: 17000, currency: 'PEN' });
  assert.equal(llamadas.cuentas.length, 0, 'no abre cuentas si salió de la web');
});

test('el aviso repetido y el COMPLETE posterior no entregan dos veces', async () => {
  usuarios.set('ana@gmail.com', { id: 'user-ana', email: 'ana@gmail.com' });
  pagos.set('pago-web', {
    id: 'pago-web', userId: 'user-ana', provider: 'HOTMART', providerOrderId: 'hm_abc', status: 'PENDING',
  });

  await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { sck: 'hm_abc' }));
  const repetido = await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { sck: 'hm_abc' }));
  const completo = await webhook.procesarAviso(aviso('PURCHASE_COMPLETE'));

  assert.equal(repetido.resultado, 'ya_entregado');
  assert.equal(completo.resultado, 'ya_entregado');
  assert.equal(llamadas.entregas.length, 1);
});

test('enlace compartido y cuenta existente: se entrega a la cuenta de ese correo', async () => {
  usuarios.set('rosa@gmail.com', { id: 'user-rosa', email: 'rosa@gmail.com' });

  const r = await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { email: '  Rosa@Gmail.com ' }));

  assert.equal(r.resultado, 'entregado');
  assert.equal(llamadas.entregas[0].payment.userId, 'user-rosa');
  assert.equal(llamadas.entregas[0].payment.providerOrderId, 'hm_tx_HP123');
  assert.equal(llamadas.cuentas.length, 0);
});

test('enlace compartido sin cuenta: se abre una sin contraseña y se entrega', async () => {
  const r = await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { email: 'nuevo@gmail.com' }));

  assert.equal(r.resultado, 'entregado');
  assert.equal(llamadas.cuentas.length, 1);
  assert.deepEqual(
    { email: llamadas.cuentas[0].email, firstName: llamadas.cuentas[0].firstName, lastName: llamadas.cuentas[0].lastName },
    { email: 'nuevo@gmail.com', firstName: 'Rosa', lastName: 'Tecocha Díaz' },
  );
  assert.equal(llamadas.cuentas[0].passwordHash, undefined);
  assert.equal(llamadas.entregas[0].payment.userId, llamadas.cuentas[0].id);
});

test('un producto que no está enlazado a ningún plan no entrega nada y avisa', async () => {
  const r = await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { productId: 999 }));

  assert.equal(r.resultado, 'sin_plan');
  assert.equal(llamadas.entregas.length, 0);
  assert.equal(llamadas.avisos.length, 1);
});

test('sin importe en soles, la fila se queda con el precio del plan', async () => {
  usuarios.set('rosa@gmail.com', { id: 'user-rosa', email: 'rosa@gmail.com' });
  const extranjero = aviso('PURCHASE_APPROVED', { precio: { value: 46, currency_value: 'USD' } });
  extranjero.data.purchase.price = { value: 800, currency_value: 'MXN' };

  await webhook.procesarAviso(extranjero);

  assert.equal(llamadas.entregas[0].captura.importeReal, undefined);
});

test('reembolso de una compra nueva: se revoca la licencia y se avisa', async () => {
  usuarios.set('rosa@gmail.com', { id: 'user-rosa', email: 'rosa@gmail.com', firstName: 'Rosa' });
  await webhook.procesarAviso(aviso('PURCHASE_APPROVED'));
  llamadas.avisos.length = 0;

  const r = await webhook.procesarAviso(aviso('PURCHASE_REFUNDED'));

  assert.equal(r.resultado, 'devuelto');
  assert.equal(r.acceso, 'revocada');
  assert.equal(llamadas.devoluciones[0].errorCode, 'HOTMART_REEMBOLSO');
  assert.deepEqual(llamadas.revocadas, [{ id: 'lic-1', motivo: 'Reembolso de la compra en Hotmart' }]);
  assert.match(llamadas.avisos[0].titulo, /reembolso/);
  assert.match(llamadas.avisos[0].mensaje, /acceso revocado/);
});

test('el reembolso repetido o el contracargo posterior no revocan dos veces', async () => {
  usuarios.set('rosa@gmail.com', { id: 'user-rosa', email: 'rosa@gmail.com' });
  await webhook.procesarAviso(aviso('PURCHASE_APPROVED'));

  await webhook.procesarAviso(aviso('PURCHASE_REFUNDED'));
  const otra = await webhook.procesarAviso(aviso('PURCHASE_REFUNDED'));
  const contracargo = await webhook.procesarAviso(aviso('PURCHASE_CHARGEBACK'));

  assert.equal(otra.resultado, 'ya_devuelto');
  assert.equal(contracargo.resultado, 'ya_devuelto');
  assert.equal(llamadas.revocadas.length, 1);
});

test('reembolso de una renovación: se quitan sus días y conserva lo pagado antes', async () => {
  usuarios.set('rosa@gmail.com', { id: 'user-rosa', email: 'rosa@gmail.com' });
  const hace = new Date(Date.now() - 30 * DIA);
  licencias.set('lic-1', { id: 'lic-1', status: 'ACTIVE', createdAt: hace, expiresAt: new Date(hace.getTime() + 360 * DIA) });
  const antes = licencias.get('lic-1').expiresAt.getTime();

  await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { transaccion: 'HP-RENUEVA' }));
  const r = await webhook.procesarAviso(aviso('PURCHASE_REFUNDED', { transaccion: 'HP-RENUEVA' }));

  assert.equal(r.acceso, 'acortada');
  assert.equal(llamadas.revocadas.length, 0);
  assert.equal(licencias.get('lic-1').expiresAt.getTime(), antes);
});

test('reembolso de una renovación que ya no deja días: se revoca', async () => {
  usuarios.set('rosa@gmail.com', { id: 'user-rosa', email: 'rosa@gmail.com' });
  // Caducada hace tiempo: la renovación es lo único que le daba acceso.
  const hace = new Date(Date.now() - 400 * DIA);
  licencias.set('lic-1', { id: 'lic-1', status: 'ACTIVE', createdAt: hace, expiresAt: new Date(Date.now() - 40 * DIA) });

  await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { transaccion: 'HP-RENUEVA' }));
  const r = await webhook.procesarAviso(aviso('PURCHASE_CHARGEBACK', { transaccion: 'HP-RENUEVA' }));

  assert.equal(r.acceso, 'revocada');
  assert.equal(llamadas.revocadas[0].motivo, 'Contracargo de la compra en Hotmart');
});

test('una compra cancelada cierra la orden abierta; un evento ajeno no toca nada', async () => {
  pagos.set('pago-web', {
    id: 'pago-web', userId: 'user-ana', provider: 'HOTMART', providerOrderId: 'hm_abc', status: 'PENDING',
  });

  assert.equal((await webhook.procesarAviso(aviso('PURCHASE_CANCELED', { sck: 'hm_abc' }))).resultado, 'cancelado');
  assert.equal(llamadas.fallos[0].errorCode, 'HOTMART_CANCELADA');
  assert.equal((await webhook.procesarAviso(aviso('PURCHASE_PROTEST'))).resultado, 'ignorado');
});

test('una orden que Hotmart canceló se entrega si después llega la aprobación', async () => {
  usuarios.set('ana@gmail.com', { id: 'user-ana', email: 'ana@gmail.com' });
  pagos.set('pago-web', {
    id: 'pago-web', userId: 'user-ana', provider: 'HOTMART', providerOrderId: 'hm_abc', status: 'FAILED',
  });

  const r = await webhook.procesarAviso(aviso('PURCHASE_APPROVED', { sck: 'hm_abc' }));

  assert.equal(r.resultado, 'entregado');
  assert.equal(llamadas.entregas[0].estadoEsperado, 'FAILED');
});
