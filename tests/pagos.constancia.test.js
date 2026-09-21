'use strict';

/**
 * Constancia de pago en PDF (21-sep-2026).
 *
 * Lo que se fija: que el número es estable, que solo la tienen los pagos
 * cobrados de verdad, que el comprador solo baja la suya (el ADMIN, cualquiera)
 * y que el correo de entrega la lleva adjunta sin dejar de salir si el PDF falla.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

const pagos = new Map();
const correos = [];
let fallarPdf = false;

falsificar('../src/config/env', { APP_URL: 'https://acostaresearch.com', MAIL_REPLY_TO: null });
falsificar('../src/config/logger', { info() {}, warn() {}, error() {} });
falsificar('../src/lib/mailer', {
  sendMail: async (correo) => {
    correos.push(correo);
  },
});
falsificar('../src/lib/emailTemplates', {
  wordsReady: () => ({ subject: 'Tu bolsa', text: 't', html: 'h' }),
  licenseReady: () => ({ subject: 'Tu acceso', text: 't', html: 'h' }),
  licenseRenewed: () => ({ subject: 'Renovada', text: 't', html: 'h' }),
});
falsificar('../src/modules/billing/billing.service', {
  getBalance: async () => ({}),
  packDataForPlan: (datos) => datos,
});
falsificar('../src/modules/billing/billing.repository', {});
falsificar('../src/modules/billing/discount.service', { registrarUso: async () => {} });
falsificar('../src/modules/licensing/license.service', {});
falsificar('../src/modules/licensing/license.repository', {});
falsificar('../src/modules/payments/proof.storage', {});
falsificar('../src/modules/payments/payment.repository', {
  findForConstancia: async (id) => {
    if (fallarPdf) throw new Error('base caída');
    return pagos.get(id) ?? null;
  },
  settle: async ({ entregar }) => {
    const { resultado } = await entregar({
      wordPack: { create: async () => ({ id: 'pack-1', wordsTotal: 1000, expiresAt: null }) },
    });
    return resultado;
  },
});

const constancia = require('../src/modules/payments/payment.constancia');
const paymentService = require('../src/modules/payments/payment.service');
const { entregarPago } = require('../src/modules/payments/payment.delivery');

const PLAN = { code: 'BASICO', name: 'Plan Básico', words: 10000, durationDays: 0, kind: 'WORDS' };

function pagoPagado(extra = {}) {
  return {
    id: '1a2b3c4d-5e6f-7a8b-9c0d-112233445566',
    userId: 'user-1',
    status: 'PAID',
    paidAt: new Date('2026-09-21T15:30:00Z'),
    amountCents: 4000,
    discountCents: 1000,
    currency: 'PEN',
    provider: 'CULQI',
    providerCaptureId: 'chr_test_abc',
    plan: PLAN,
    user: { id: 'user-1', email: 'maria@correo.pe', firstName: 'María', lastName: 'Ñahui' },
    discountCode: { code: 'PROMO10' },
    ...extra,
  };
}

test.beforeEach(() => {
  pagos.clear();
  correos.length = 0;
  fallarPdf = false;
});

test('el número sale de la fecha de pago en Lima y del identificador, siempre igual', () => {
  const pago = pagoPagado();
  assert.equal(constancia.numeroDeConstancia(pago), 'CP-20260921-1A2B3C4D');
  // 02:00 en UTC del 22 todavía es el 21 en Lima.
  assert.equal(
    constancia.numeroDeConstancia(pagoPagado({ paidAt: new Date('2026-09-22T02:00:00Z') })),
    'CP-20260921-1A2B3C4D',
  );
});

test('los datos llevan precio, descuento con su código y total pagado', () => {
  const datos = constancia.datosDeConstancia(pagoPagado());
  assert.equal(datos.subtotal, 'S/ 50.00');
  assert.equal(datos.descuento, '- S/ 10.00 (código PROMO10)');
  assert.equal(datos.total, 'S/ 40.00');
  assert.equal(datos.cliente, 'María Ñahui');
  assert.equal(datos.medio, 'Tarjeta o Yape (Culqi)');
  assert.equal(datos.referencia, 'chr_test_abc');
});

test('un pago en dólares sin descuento no enseña fila de descuento', () => {
  const datos = constancia.datosDeConstancia(
    pagoPagado({ currency: 'USD', amountCents: 1500, discountCents: 0, provider: 'PAYPAL' }),
  );
  assert.equal(datos.total, 'US$ 15.00');
  assert.equal(datos.descuento, null);
  assert.equal(datos.medio, 'PayPal');
});

test('solo tienen constancia los pagos cobrados y con importe', () => {
  assert.equal(constancia.tieneConstancia(pagoPagado()), true);
  assert.equal(constancia.tieneConstancia(pagoPagado({ status: 'PENDING' })), false);
  assert.equal(constancia.tieneConstancia(pagoPagado({ status: 'IN_REVIEW' })), false);
  assert.equal(constancia.tieneConstancia(pagoPagado({ amountCents: 0 })), false);
});

test('el PDF se genera', async () => {
  const pdf = await constancia.generarConstancia(pagoPagado());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('el comprador descarga la suya', async () => {
  const pago = pagoPagado();
  pagos.set(pago.id, pago);

  const { nombre, pdf } = await paymentService.constancia({ id: pago.id, userId: 'user-1', role: 'USER' });
  assert.equal(nombre, 'constancia-de-pago-CP-20260921-1A2B3C4D.pdf');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('la de otro comprador no se puede bajar; el administrador sí', async () => {
  const pago = pagoPagado();
  pagos.set(pago.id, pago);

  await assert.rejects(
    paymentService.constancia({ id: pago.id, userId: 'otro', role: 'USER' }),
    { statusCode: 404 },
  );
  const { pdf } = await paymentService.constancia({ id: pago.id, userId: 'admin', role: 'ADMIN' });
  assert.ok(pdf.length > 0);
});

test('un pago sin confirmar no tiene constancia', async () => {
  const pago = pagoPagado({ status: 'IN_REVIEW', paidAt: null });
  pagos.set(pago.id, pago);

  await assert.rejects(
    paymentService.constancia({ id: pago.id, userId: 'user-1', role: 'USER' }),
    { statusCode: 409 },
  );
});

/** Espera a que el correo, que sale sin bloquear, termine de enviarse. */
const esperarCorreo = () => new Promise((resuelve) => setTimeout(resuelve, 50));

test('el correo de entrega lleva la constancia adjunta', async () => {
  const pago = pagoPagado();
  pagos.set(pago.id, pago);

  await entregarPago({ payment: { ...pago, status: 'PENDING' }, captura: { captureId: 'chr_test_abc' } });
  await esperarCorreo();

  assert.equal(correos.length, 1);
  const [adjunto] = correos[0].attachments;
  assert.equal(adjunto.filename, 'constancia-de-pago-CP-20260921-1A2B3C4D.pdf');
  assert.equal(adjunto.contentType, 'application/pdf');
  assert.equal(adjunto.content.subarray(0, 5).toString(), '%PDF-');
});

test('si la constancia falla, el correo de entrega sale igual, sin adjunto', async () => {
  fallarPdf = true;

  await entregarPago({ payment: pagoPagado({ status: 'PENDING' }), captura: { captureId: 'x' } });
  await esperarCorreo();

  assert.equal(correos.length, 1);
  assert.deepEqual(correos[0].attachments, []);
});

test('el número de operación no enseña identificadores internos nuestros', () => {
  const plinSinNumero = pagoPagado({
    provider: 'PLIN',
    providerCaptureId: '7190c5de-e75c-49b2-93a4-f72010e18230',
  });
  assert.equal(constancia.datosDeConstancia(plinSinNumero).referencia, null);

  const yapeConNumero = pagoPagado({ provider: 'YAPE', operationCode: '01234567', providerCaptureId: '01234567' });
  assert.equal(constancia.datosDeConstancia(yapeConNumero).referencia, '01234567');
});

test('las condiciones de licencia solo salen en planes de licencia', () => {
  const licencia = constancia.datosDeConstancia(
    pagoPagado({ plan: { ...PLAN, kind: 'LICENSE', words: 0, durationDays: 360 } }),
  );
  const palabras = constancia.datosDeConstancia(pagoPagado());

  assert.match(licencia.condiciones[0], /intransferible/);
  assert.ok(!palabras.condiciones.some((texto) => /intransferible/.test(texto)));
  assert.ok(licencia.condiciones.some((texto) => /acostaresearch\.com\/terminos/.test(texto)));
  assert.equal(licencia.detalle, 'acceso por 360 días');
});
