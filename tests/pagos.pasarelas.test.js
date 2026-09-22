'use strict';

/**
 * Cobro en línea: Culqi (tarjeta y Yape en soles) y PayPal (dólares).
 *
 * Culqi entró el 21-sep-2026 como pasarela NUEVA, sin quitar PayPal. Lo que se
 * fija aquí es doble:
 *
 *  - que Culqi cobra el importe guardado en el pago (nunca el del navegador),
 *    que un rechazo del banco deja el pago abierto para reintentar y que el
 *    3-D Secure no entrega nada hasta que el banco lo confirma;
 *  - que PayPal sigue cobrando exactamente igual: mismo importe, mismo
 *    descuento en dólares, y sin pedir nada nuevo al navegador.
 *
 * La red y la base son falsas: `fetch` se sustituye y los repositorios se
 * cargan en `require.cache` antes que el servicio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Dobles ─────────────────────────────────────────────────────────────────

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

const envFalso = {
  paypalEnabled: true,
  culqiEnabled: true,
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secreto',
  paypalApiBase: 'https://paypal.falso',
  CULQI_PUBLIC_KEY: 'pk_test_publica',
  CULQI_SECRET_KEY: 'sk_test_secreta',
};

const PLAN = {
  id: 'plan-1',
  code: 'BASICO',
  name: 'Plan Básico',
  words: 10000,
  active: true,
  priceCents: 5000, // S/ 50.00
  priceUsdCents: 1500, // $ 15.00
  kind: 'WORDS',
};

const pagos = new Map();
const llamadas = { fail: [], noteAttempt: [], entregas: [], fetch: [] };
let descuentoFalso = null;
let respuestasFetch = [];

falsificar('../src/config/env', envFalso);
falsificar('../src/config/logger', { info() {}, warn() {}, error() {} });
falsificar('../src/modules/billing/billing.repository', {
  findPlanByCode: async (code) => (code === PLAN.code ? PLAN : null),
});
falsificar('../src/modules/billing/billing.service', { getBalance: async () => ({ words: 0 }) });
falsificar('../src/modules/billing/discount.service', {
  resolve: async ({ code }) => (code ? descuentoFalso : null),
});
falsificar('../src/modules/licensing/license.repository', { findById: async () => null });
falsificar('../src/modules/payments/proof.storage', { borrar: async () => {} });
falsificar('../src/modules/payments/payment.delivery', {
  entregarPago: async ({ payment, captura }) => {
    llamadas.entregas.push({ payment, captura });
    payment.status = 'PAID';
    return { pack: { id: 'pack-1' } };
  },
});
falsificar('../src/modules/payments/payment.repository', {
  create: async (data) => {
    const fila = { id: `pay-${pagos.size + 1}`, status: 'PENDING', ...data };
    pagos.set(`${data.provider}:${data.providerOrderId}`, fila);
    return fila;
  },
  findByOrderId: async (provider, orderId) => {
    const fila = pagos.get(`${provider}:${orderId}`);
    return fila
      ? { ...fila, plan: PLAN, user: { id: fila.userId, email: 'tesista@correo.pe' } }
      : null;
  },
  fail: async (id, datos) => {
    llamadas.fail.push({ id, ...datos });
    for (const fila of pagos.values()) if (fila.id === id) fila.status = 'FAILED';
  },
  noteAttempt: async (id, datos) => llamadas.noteAttempt.push({ id, ...datos }),
});

/** Lee el cuerpo enviado; el del token de PayPal va como formulario, no JSON. */
function cuerpoEnviado(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

global.fetch = async (url, opciones = {}) => {
  // El token de PayPal se guarda en memoria entre pruebas: se contesta aparte
  // para que el orden de las respuestas no dependa de qué prueba corrió antes.
  if (url.endsWith('/v1/oauth2/token')) {
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
    };
  }

  llamadas.fetch.push({ url, opciones, cuerpo: cuerpoEnviado(opciones.body) });
  const siguiente = respuestasFetch.shift();
  if (!siguiente) throw new Error(`fetch inesperado a ${url}`);
  return {
    status: siguiente.status,
    ok: siguiente.status >= 200 && siguiente.status < 300,
    text: async () => JSON.stringify(siguiente.body),
  };
};

const paymentService = require('../src/modules/payments/payment.service');
const { captureBodySchema } = require('../src/modules/payments/payment.schema');

test.beforeEach(() => {
  pagos.clear();
  for (const lista of Object.values(llamadas)) lista.length = 0;
  descuentoFalso = null;
  respuestasFetch = [];
});

/** Cargo correcto tal como lo devuelve Culqi (201). */
function cargoCulqi({ amount = 5000, currency = 'PEN', tipo = 'venta_exitosa' } = {}) {
  return {
    status: 201,
    body: {
      object: 'charge',
      id: 'chr_test_abcdefghijklmnop',
      amount,
      currency_code: currency,
      email: 'tesista@correo.pe',
      outcome: { type: tipo, user_message: 'Su compra ha sido exitosa.' },
    },
  };
}

async function abrirCulqi(opciones = {}) {
  return paymentService.createOrder({
    userId: 'user-1',
    planCode: 'BASICO',
    providerCode: 'CULQI',
    ...opciones,
  });
}

// ── Qué pasarelas se ofrecen ───────────────────────────────────────────────

test('se ofrecen las dos pasarelas; solo Culqi lleva llave pública', () => {
  const lista = paymentService.listProviders();
  const paypal = lista.find((p) => p.code === 'PAYPAL');
  const culqi = lista.find((p) => p.code === 'CULQI');

  assert.deepEqual(paypal, { code: 'PAYPAL', label: 'PayPal', currency: 'USD' });
  assert.equal(culqi.currency, 'PEN');
  assert.equal(culqi.publicKey, 'pk_test_publica');
});

test('sin llaves de Culqi, solo queda PayPal, igual que antes', () => {
  envFalso.culqiEnabled = false;
  try {
    const codigos = paymentService.listProviders().map((p) => p.code);
    assert.deepEqual(codigos, ['PAYPAL']);
  } finally {
    envFalso.culqiEnabled = true;
  }
});

// ── Abrir la orden ─────────────────────────────────────────────────────────

test('Culqi abre la orden en soles con el precio del plan y sin llamar a la red', async () => {
  const orden = await abrirCulqi();

  assert.equal(orden.amountCents, 5000);
  assert.equal(orden.currency, 'PEN');
  assert.match(orden.orderId, /^cq_/);
  assert.equal(llamadas.fetch.length, 0);
});

test('con código de descuento, Culqi resta la rebaja en soles', async () => {
  descuentoFalso = { id: 'd1', code: 'PROMO', amountCents: 1000, discountUsdCents: 300 };

  const orden = await abrirCulqi({ discountCode: 'PROMO' });

  assert.equal(orden.amountCents, 4000);
  assert.deepEqual(orden.discount, { code: 'PROMO', amountCents: 1000 });
});

test('PayPal sigue cobrando en dólares y restando la rebaja en dólares', async () => {
  descuentoFalso = { id: 'd1', code: 'PROMO', amountCents: 1000, discountUsdCents: 300 };
  respuestasFetch = [
    { status: 201, body: { id: 'PAYPAL-ORDEN-1', links: [{ rel: 'approve', href: 'https://x' }] } },
  ];

  const orden = await paymentService.createOrder({
    userId: 'user-1',
    planCode: 'BASICO',
    providerCode: 'PAYPAL',
    discountCode: 'PROMO',
  });

  assert.equal(orden.amountCents, 1200);
  assert.equal(orden.currency, 'USD');
  assert.equal(orden.orderId, 'PAYPAL-ORDEN-1');
  const cuerpo = llamadas.fetch[0].cuerpo;
  assert.equal(cuerpo.purchase_units[0].amount.value, '12.00');
  assert.equal(cuerpo.purchase_units[0].amount.currency_code, 'USD');
});

// ── Confirmar el cobro con Culqi ───────────────────────────────────────────

test('Culqi cobra el importe guardado, con la llave secreta, y entrega', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [cargoCulqi()];

  const resultado = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'CULQI',
    datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
  });

  assert.equal(resultado.alreadyProcessed, false);
  assert.equal(llamadas.entregas.length, 1);

  const { url, opciones, cuerpo } = llamadas.fetch[0];
  assert.equal(url, 'https://api.culqi.com/v2/charges');
  assert.equal(opciones.headers.Authorization, 'Bearer sk_test_secreta');
  assert.equal(cuerpo.amount, 5000);
  assert.equal(cuerpo.currency_code, 'PEN');
  assert.equal(cuerpo.source_id, 'tkn_test_0CjjdWhFpEAZlxlz');
  assert.equal(cuerpo.email, 'tesista@correo.pe');
  assert.equal(cuerpo.metadata.payment_id, 'pay-1');
  assert.equal(llamadas.entregas[0].captura.captureId, 'chr_test_abcdefghijklmnop');
});

test('Culqi sin token no llama a la pasarela ni da el pago por fallido', async () => {
  const orden = await abrirCulqi();

  await assert.rejects(
    paymentService.captureOrder({ userId: 'user-1', orderId: orden.orderId, providerCode: 'CULQI' }),
    { statusCode: 422 },
  );
  assert.equal(llamadas.fetch.length, 0);
  assert.equal(llamadas.fail.length, 0);
});

test('si el banco pide 3-D Secure, no se entrega nada y el pago sigue abierto', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [
    { status: 200, body: { action_code: 'REVIEW', user_message: 'El usuario necesita autenticarse' } },
  ];

  const resultado = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'CULQI',
    datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
  });

  assert.equal(resultado.requiresAuthentication, true);
  assert.equal(llamadas.entregas.length, 0);
  assert.equal(llamadas.fail.length, 0);
});

test('la petición de 3DS se reconoce aunque llegue con 201', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [{ status: 201, body: { action_code: 'REVIEW' } }];

  const resultado = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'CULQI',
    datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
  });

  assert.equal(resultado.requiresAuthentication, true);
  assert.equal(llamadas.entregas.length, 0);
});

test('el segundo intento con 3DS manda los parámetros del banco y cobra', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [cargoCulqi()];
  const autenticacion = { eci: '05', xid: 'x', cavv: 'c', protocolVersion: '2.1.0' };

  await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'CULQI',
    datosDelCobro: {
      token: 'tkn_test_0CjjdWhFpEAZlxlz',
      deviceFingerprint: 'huella-1',
      authentication3DS: autenticacion,
    },
  });

  const { cuerpo } = llamadas.fetch[0];
  assert.deepEqual(cuerpo.authentication_3DS, autenticacion);
  assert.equal(cuerpo.antifraud_details.device_finger_print_id, 'huella-1');
  assert.equal(llamadas.entregas.length, 1);
});

test('tarjeta rechazada: mensaje del banco, pago abierto y se puede reintentar', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [
    {
      status: 402,
      body: {
        object: 'error',
        type: 'card_error',
        decline_code: 'insufficient_funds',
        user_message: 'Su tarjeta no tiene fondos suficientes.',
      },
    },
    cargoCulqi(),
  ];

  await assert.rejects(
    paymentService.captureOrder({
      userId: 'user-1',
      orderId: orden.orderId,
      providerCode: 'CULQI',
      datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
    }),
    { statusCode: 402, code: 'PAYMENT_DECLINED', message: 'Su tarjeta no tiene fondos suficientes.' },
  );
  assert.equal(llamadas.fail.length, 0);
  assert.equal(llamadas.noteAttempt[0].errorCode, 'insufficient_funds');

  // Otra tarjeta, mismo pago.
  const resultado = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'CULQI',
    datosDelCobro: { token: 'tkn_test_otraTarjeta12345' },
  });
  assert.equal(resultado.alreadyProcessed, false);
  assert.equal(llamadas.entregas.length, 1);
});

test('si Culqi cobra otro importe, no se entrega nada y queda registrado', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [cargoCulqi({ amount: 100 })];

  await assert.rejects(
    paymentService.captureOrder({
      userId: 'user-1',
      orderId: orden.orderId,
      providerCode: 'CULQI',
      datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
    }),
    { statusCode: 409 },
  );
  assert.equal(llamadas.entregas.length, 0);
  assert.equal(llamadas.fail[0].errorCode, 'AMOUNT_MISMATCH');
});

test('un error de Culqi que no es del banco cierra el pago como fallido', async () => {
  const orden = await abrirCulqi();
  respuestasFetch = [{ status: 401, body: { object: 'error', type: 'authentication_error' } }];

  await assert.rejects(
    paymentService.captureOrder({
      userId: 'user-1',
      orderId: orden.orderId,
      providerCode: 'CULQI',
      datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
    }),
    { statusCode: 400, code: 'PAYMENT_FAILED' },
  );
  assert.equal(llamadas.fail[0].errorCode, 'GATEWAY_ERROR');
});

test('una orden de Culqi no se confirma desde otra cuenta', async () => {
  const orden = await abrirCulqi();

  await assert.rejects(
    paymentService.captureOrder({
      userId: 'otro-usuario',
      orderId: orden.orderId,
      providerCode: 'CULQI',
      datosDelCobro: { token: 'tkn_test_0CjjdWhFpEAZlxlz' },
    }),
    { statusCode: 404 },
  );
  assert.equal(llamadas.fetch.length, 0);
});

// ── PayPal no cambia ───────────────────────────────────────────────────────

test('PayPal confirma sin token, como siempre', async () => {
  respuestasFetch = [
    { status: 201, body: { id: 'PAYPAL-ORDEN-2', links: [] } },
  ];
  const orden = await paymentService.createOrder({
    userId: 'user-1',
    planCode: 'BASICO',
    providerCode: 'PAYPAL',
  });
  respuestasFetch = [
    {
      status: 201,
      body: {
        payer: { email_address: 'p@x.com' },
        purchase_units: [
          {
            payments: {
              captures: [
                { id: 'CAP-1', status: 'COMPLETED', amount: { value: '15.00', currency_code: 'USD' } },
              ],
            },
          },
        ],
      },
    },
  ];

  const resultado = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'PAYPAL',
    datosDelCobro: {},
  });

  assert.equal(resultado.alreadyProcessed, false);
  assert.match(llamadas.fetch.at(-1).url, /\/v2\/checkout\/orders\/PAYPAL-ORDEN-2\/capture$/);
  assert.equal(llamadas.entregas[0].captura.captureId, 'CAP-1');
});

// ── Lo que acepta la ruta ──────────────────────────────────────────────────

test('la confirmación acepta cuerpo vacío (PayPal) y rechaza tokens raros', () => {
  assert.deepEqual(captureBodySchema.parse(undefined), {});
  assert.deepEqual(captureBodySchema.parse({}), {});
  assert.equal(captureBodySchema.parse({ token: 'ype_test_abc123' }).token, 'ype_test_abc123');
  assert.equal(captureBodySchema.safeParse({ token: 'chr_test_abc' }).success, false);
  assert.equal(
    captureBodySchema.safeParse({ authentication3DS: { eci: '05', otro: 'x' } }).success,
    false,
  );
});
