'use strict';

/**
 * Compra con carrito: varios productos pagados de una vez (1-oct-2026).
 *
 * Lo que se fija aquí:
 *
 *  - que el carrito abre UNA orden por la suma, con el precio y el descuento
 *    de cada línea puestos por el servidor, y guarda una fila por producto;
 *  - que se cobra una sola vez y se entrega cada producto, y que si el importe
 *    no cuadra no se entrega ninguno;
 *  - que el Yape de un carrito es UN comprobante: una captura, una fila en la
 *    bandeja por la suma, y aprobarlo entrega todo.
 *
 * La red y la base son falsas, como en `pagos.pasarelas.test.js`.
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
  ADMIN_NOTIFY_EMAIL: 'admin@acosta.pe',
  APP_URL: 'https://acosta.pe',
  yape: { titular: 'Acosta', numero: '999' },
};

const PLANES = {
  METODO: {
    id: 'plan-metodo',
    code: 'METODO',
    productCode: 'METODO',
    name: 'Método de Tesis',
    kind: 'LICENSE',
    words: 0,
    active: true,
    priceCents: 15900,
    priceUsdCents: 4500,
  },
  ARTICULO: {
    id: 'plan-articulo',
    code: 'ARTICULO',
    productCode: 'ARTICULO',
    name: 'Artículos Científicos',
    kind: 'LICENSE',
    words: 0,
    active: true,
    priceCents: 22000,
    priceUsdCents: 6000,
  },
  // Otro plan del MISMO producto que METODO, como una oferta suelta.
  METODO_OFERTA: {
    id: 'plan-metodo-oferta',
    code: 'METODO_OFERTA',
    productCode: 'METODO',
    name: 'Método de Tesis (oferta)',
    kind: 'LICENSE',
    words: 0,
    active: true,
    priceCents: 12900,
    priceUsdCents: 3600,
  },
};

const filas = new Map(); // id → fila
const llamadas = { fetch: [], entregas: [], fail: [], cancelCart: [], cancelOtherOpen: [], avisos: [], revisiones: [], proofChecks: [] };
let respuestasFetch = [];
let descuentos = {}; // código → descuento
let generales = {}; // código del carrito sin plan → registro
let fallaLaEntregaDe = null; // código de plan cuya entrega revienta
let veredictoDelOcr = 'OK'; // lo que «lee» el OCR falso en la captura

function conPlan(fila) {
  const plan = Object.values(PLANES).find((p) => p.id === fila.planId);
  return { ...fila, plan, user: { id: fila.userId, email: 'tesista@correo.pe', firstName: 'Ana' } };
}

falsificar('../src/config/env', envFalso);
falsificar('../src/config/logger', { info() {}, warn() {}, error() {} });
falsificar('../src/lib/notify', { avisarAlAdmin: (aviso) => llamadas.avisos.push(aviso) });
falsificar('../src/lib/mailer', { sendMail: async () => {} });
falsificar('../src/lib/emailTemplates', {
  manualPaymentReceived: (datos) => ({ subject: 'yape', datos }),
  manualPaymentRejected: (datos) => ({ subject: 'rechazo', datos }),
});
falsificar('../src/lib/prisma', {
  user: { findUnique: async () => ({ id: 'user-1', email: 'tesista@correo.pe', firstName: 'Ana' }) },
  payment: {
    findUnique: async ({ where }) => (filas.has(where.id) ? conPlan(filas.get(where.id)) : null),
  },
});
falsificar('../src/modules/billing/billing.repository', {
  findPlanByCode: async (code) => PLANES[code] ?? null,
});
falsificar('../src/modules/billing/billing.service', { getBalance: async () => ({ words: 0 }) });
falsificar('../src/modules/billing/discount.service', {
  resolve: async ({ code }) => (code ? (descuentos[code] ?? null) : null),
  // Los códigos del carrito: los de un producto llevan `planCode`.
  encontrar: async (code) => {
    const registro = generales[code] ?? descuentos[code];
    if (!registro) throw new Error('Ese código de descuento no es válido.');
    return registro;
  },
  // La misma proporción en dólares que el servicio de verdad.
  aplicarAlTotal: (registro, total) => ({
    id: registro.id,
    code: registro.code,
    amountCents: registro.amountCents,
    discountUsdCents: Math.round((total.priceUsdCents * registro.amountCents) / total.priceCents),
    finalPriceCents: total.priceCents - registro.amountCents,
  }),
});
falsificar('../src/modules/licensing/license.repository', {
  listForUser: async () => [],
  findById: async (id) => ({ id, productCode: 'X' }),
});
// El OCR de verdad carga tesseract: aquí basta con apuntar qué se le pidió.
falsificar('../src/modules/payments/proof.revision', {
  revisarCaptura: async (_buffer, opciones) => {
    llamadas.revisiones.push(opciones);
    return { veredicto: veredictoDelOcr, operacionLeida: opciones.operationCode ?? null };
  },
});
falsificar('../src/modules/payments/proof.storage', {
  comprobarImagen: () => ({ mime: 'image/png' }),
  guardar: async () => ({ path: 'captura-1.png', mime: 'image/png' }),
  borrar: async () => {},
});
falsificar('../src/modules/payments/payment.delivery', {
  entregarPago: async ({ payment, captura, estadoEsperado }) => {
    if (payment.plan.code === fallaLaEntregaDe) throw new Error('se cayó la base');
    llamadas.entregas.push({ payment, captura, estadoEsperado });
    const fila = filas.get(payment.id);
    if (fila.status !== estadoEsperado) return null;
    fila.status = 'PAID';
    fila.licenseId = `lic-${payment.plan.code}`;
    return {
      license: { id: fila.licenseId, productCode: payment.plan.productCode },
      connectorUrl: `https://mcp/${payment.plan.code}`,
    };
  },
});
falsificar('../src/modules/payments/payment.repository', {
  create: async (data) => {
    const fila = { id: `pay-${filas.size + 1}`, status: 'PENDING', cartId: null, ...data };
    filas.set(fila.id, fila);
    return fila;
  },
  createCart: async (datos) =>
    datos.map((data) => {
      const fila = { id: `pay-${filas.size + 1}`, status: 'PENDING', ...data };
      filas.set(fila.id, fila);
      return fila;
    }),
  findCart: async (cartId) =>
    [...filas.values()].filter((f) => f.cartId === cartId).reverse().map(conPlan),
  findByOrderId: async (provider, orderId) => {
    const fila = [...filas.values()].find(
      (f) => f.provider === provider && f.providerOrderId === orderId,
    );
    return fila ? conPlan(fila) : null;
  },
  fail: async (id, datos) => {
    llamadas.fail.push({ id, ...datos });
    if (filas.get(id).status === 'PENDING') filas.get(id).status = 'FAILED';
  },
  noteAttempt: async () => {},
  cancelOtherOpen: async (datos) => {
    llamadas.cancelOtherOpen.push(datos);
    return 0;
  },
  cancelCart: async (cartId, userId, motivo) => {
    llamadas.cancelCart.push({ cartId, userId, motivo });
    return true;
  },
  cancel: async () => true,
  saveProofCheck: async (ids, revision) => {
    llamadas.proofChecks.push({ ids, revision });
  },
  attachProof: async (id, { proofPath }) => {
    Object.assign(filas.get(id), { proofPath, status: 'IN_REVIEW' });
    return true;
  },
  listInReview: async () =>
    [...filas.values()].filter((f) => f.status === 'IN_REVIEW').map(conPlan),
  markReviewed: async () => {},
  reject: async (id) => {
    if (filas.get(id).status !== 'IN_REVIEW') return false;
    filas.get(id).status = 'REJECTED';
    return true;
  },
});

global.fetch = async (url, opciones = {}) => {
  if (url.endsWith('/v1/oauth2/token')) {
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
    };
  }
  llamadas.fetch.push({ url, cuerpo: opciones.body ? JSON.parse(opciones.body) : null });
  const siguiente = respuestasFetch.shift();
  if (!siguiente) throw new Error(`fetch inesperado a ${url}`);
  return {
    status: siguiente.status,
    ok: siguiente.status >= 200 && siguiente.status < 300,
    text: async () => JSON.stringify(siguiente.body),
  };
};

const paymentService = require('../src/modules/payments/payment.service');
const manualService = require('../src/modules/payments/manual.service');

test.beforeEach(() => {
  filas.clear();
  for (const lista of Object.values(llamadas)) lista.length = 0;
  respuestasFetch = [];
  descuentos = {};
  generales = {};
  fallaLaEntregaDe = null;
  veredictoDelOcr = 'OK';
});

/** La orden de PayPal recién creada. */
const ordenPaypal = (id = 'PP-1') => ({ status: 201, body: { id, links: [] } });

/** La captura de PayPal por un importe en dólares. */
function capturaPaypal(valor, { id = 'CAP-1', moneda = 'USD' } = {}) {
  return {
    status: 201,
    body: {
      payer: { email_address: 'tesista@correo.pe' },
      purchase_units: [
        {
          payments: {
            captures: [{ id, status: 'COMPLETED', amount: { value: valor, currency_code: moneda } }],
          },
        },
      ],
    },
  };
}

async function abrirCarritoPaypal(items = [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }]) {
  respuestasFetch = [ordenPaypal()];
  return paymentService.createCartOrder({ userId: 'user-1', items, providerCode: 'PAYPAL' });
}

// ── Abrir la orden ─────────────────────────────────────────────────────────

test('el carrito abre UNA orden por la suma, con el descuento de cada línea', async () => {
  descuentos.PROMO40 = { id: 'd1', code: 'PROMO40', amountCents: 4000, discountUsdCents: 1100 };

  const orden = await abrirCarritoPaypal([
    { planCode: 'METODO', discountCode: 'PROMO40' },
    { planCode: 'ARTICULO' },
  ]);

  // 45 − 11 + 60 = 94 dólares
  assert.equal(orden.amountCents, 9400);
  assert.equal(orden.currency, 'USD');
  assert.equal(llamadas.fetch.length, 1);
  const unidad = llamadas.fetch[0].cuerpo.purchase_units[0];
  assert.equal(unidad.amount.value, '94.00');
  assert.equal(unidad.description, 'Método de Tesis + Artículos Científicos');

  // Una fila por producto, con su propio importe, unidas por el carrito.
  const guardadas = [...filas.values()];
  assert.equal(guardadas.length, 2);
  assert.deepEqual(
    guardadas.map((f) => [f.providerOrderId, f.amountCents, f.discountCents]),
    [
      ['PP-1', 3400, 1100],
      ['PP-1#2', 6000, 0],
    ],
  );
  assert.ok(guardadas[0].cartId);
  assert.equal(guardadas[0].cartId, guardadas[1].cartId);

  // Y no se cierran las filas del propio carrito al cerrar las anteriores.
  assert.equal(llamadas.cancelOtherOpen[0].exceptCartId, guardadas[0].cartId);

  assert.deepEqual(
    orden.items.map((i) => [i.plan.code, i.amountCents, i.discount?.code ?? null]),
    [
      ['METODO', 3400, 'PROMO40'],
      ['ARTICULO', 6000, null],
    ],
  );
});

test('Culqi abre el carrito en soles con el precio de catálogo', async () => {
  const orden = await paymentService.createCartOrder({
    userId: 'user-1',
    items: [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }],
    providerCode: 'CULQI',
  });

  assert.equal(orden.amountCents, 37900);
  assert.equal(orden.currency, 'PEN');
  assert.equal(llamadas.fetch.length, 0);
});

test('el mismo producto dos veces no entra, aunque sea con otro plan', async () => {
  await assert.rejects(
    paymentService.createCartOrder({
      userId: 'user-1',
      items: [{ planCode: 'METODO' }, { planCode: 'METODO_OFERTA' }],
      providerCode: 'PAYPAL',
    }),
    /ya está en el carrito/,
  );
  assert.equal(filas.size, 0);
  assert.equal(llamadas.fetch.length, 0);
});

test('un plan que no existe tumba el carrito entero, sin abrir nada', async () => {
  await assert.rejects(
    paymentService.createCartOrder({
      userId: 'user-1',
      items: [{ planCode: 'METODO' }, { planCode: 'NO_EXISTE' }],
      providerCode: 'PAYPAL',
    }),
    /No existe un plan activo/,
  );
  assert.equal(filas.size, 0);
});

// ── Cobrar ─────────────────────────────────────────────────────────────────

test('se cobra una vez y se entrega cada producto, con su URL', async () => {
  const orden = await abrirCarritoPaypal();
  respuestasFetch = [capturaPaypal('105.00')];

  const resultado = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'PAYPAL',
  });

  assert.equal(resultado.alreadyProcessed, false);
  assert.equal(llamadas.fetch.length, 2); // abrir + capturar, nada más
  assert.equal(llamadas.entregas.length, 2);
  // La de la orden real primero, y las dos con la misma captura.
  assert.deepEqual(
    llamadas.entregas.map((e) => [e.payment.plan.code, e.captura.captureId]),
    [
      ['METODO', 'CAP-1'],
      ['ARTICULO', 'CAP-1'],
    ],
  );
  assert.deepEqual(
    resultado.items.map((i) => [i.plan.code, i.connectorUrl]),
    [
      ['METODO', 'https://mcp/METODO'],
      ['ARTICULO', 'https://mcp/ARTICULO'],
    ],
  );
  assert.ok([...filas.values()].every((f) => f.status === 'PAID'));
});

test('si lo cobrado no es la suma, no se entrega nada y fallan todas las filas', async () => {
  const orden = await abrirCarritoPaypal();
  respuestasFetch = [capturaPaypal('45.00')];

  await assert.rejects(
    paymentService.captureOrder({ userId: 'user-1', orderId: orden.orderId, providerCode: 'PAYPAL' }),
    /no coincide/,
  );

  assert.equal(llamadas.entregas.length, 0);
  assert.deepEqual(
    llamadas.fail.map((f) => f.errorCode),
    ['AMOUNT_MISMATCH', 'AMOUNT_MISMATCH'],
  );
});

test('confirmar otra vez un carrito ya cobrado no cobra ni entrega de nuevo', async () => {
  const orden = await abrirCarritoPaypal();
  respuestasFetch = [capturaPaypal('105.00')];
  await paymentService.captureOrder({ userId: 'user-1', orderId: orden.orderId, providerCode: 'PAYPAL' });

  const otra = await paymentService.captureOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'PAYPAL',
  });

  assert.equal(otra.alreadyProcessed, true);
  assert.equal(otra.items.length, 2);
  assert.equal(llamadas.entregas.length, 2);
  assert.equal(llamadas.fetch.length, 2);
});

test('si una entrega falla tras cobrar, las otras quedan y se avisa al administrador', async () => {
  const orden = await abrirCarritoPaypal();
  respuestasFetch = [capturaPaypal('105.00')];
  fallaLaEntregaDe = 'ARTICULO';

  await assert.rejects(
    paymentService.captureOrder({ userId: 'user-1', orderId: orden.orderId, providerCode: 'PAYPAL' }),
    /no pudimos activar Artículos Científicos/,
  );

  const [metodo, articulo] = [...filas.values()];
  assert.equal(metodo.status, 'PAID');
  assert.equal(articulo.status, 'PENDING');
  assert.equal(llamadas.avisos.length, 1);
});

test('una orden de carrito no se confirma desde otra cuenta', async () => {
  const orden = await abrirCarritoPaypal();

  await assert.rejects(
    paymentService.captureOrder({ userId: 'intruso', orderId: orden.orderId, providerCode: 'PAYPAL' }),
    /No encontramos ese pago/,
  );
  assert.equal(llamadas.fetch.length, 1);
});

test('cancelar la orden cierra el carrito entero', async () => {
  const orden = await abrirCarritoPaypal();

  await paymentService.cancelOrder({
    userId: 'user-1',
    orderId: orden.orderId,
    providerCode: 'PAYPAL',
    motivo: 'cerró la ventana',
  });

  assert.equal(llamadas.cancelCart.length, 1);
  assert.equal(llamadas.cancelCart[0].cartId, [...filas.values()][0].cartId);
});

// ── Yape ───────────────────────────────────────────────────────────────────

async function yapeDeCarrito() {
  descuentos.PROMO40 = { id: 'd1', code: 'PROMO40', amountCents: 4000, discountUsdCents: 1100 };
  return manualService.registrarCarrito({
    userId: 'user-1',
    items: [{ planCode: 'METODO', discountCode: 'PROMO40' }, { planCode: 'ARTICULO' }],
    operationCode: '123456',
    buffer: Buffer.from('png'),
  });
}

test('el Yape de un carrito es una captura por la suma en soles', async () => {
  const enviado = await yapeDeCarrito();

  // 159 − 40 + 220 = 339 soles
  assert.equal(enviado.amountCents, 33900);
  assert.equal(enviado.status, 'IN_REVIEW');
  const guardadas = [...filas.values()];
  assert.equal(guardadas.length, 2);
  assert.ok(guardadas.every((f) => f.proofPath === 'captura-1.png' && f.status === 'IN_REVIEW'));
  assert.ok(guardadas.every((f) => f.operationCode === '123456'));
  // Un solo empujón al móvil, por la suma.
  assert.equal(llamadas.avisos.length, 1);
  assert.match(llamadas.avisos[0].titulo, /339\.00/);
});

test('la bandeja enseña el carrito una sola vez, con la suma y lo que lleva', async () => {
  await yapeDeCarrito();

  const bandeja = await manualService.pendientes();

  assert.equal(bandeja.length, 1);
  assert.equal(bandeja[0].amountCents, 33900);
  assert.equal(bandeja[0].discountCents, 4000);
  assert.deepEqual(bandeja[0].carrito.productos, ['Método de Tesis', 'Artículos Científicos']);
  assert.equal(bandeja[0].carrito.pagos.length, 2);
});

test('aprobar una fila del carrito entrega todos sus productos', async () => {
  await yapeDeCarrito();
  const [primera] = [...filas.values()];

  const resultado = await manualService.aprobar({ paymentId: primera.id, adminId: 'admin-1' });

  assert.equal(resultado.alreadyProcessed, false);
  assert.equal(resultado.entregados.length, 2);
  assert.ok([...filas.values()].every((f) => f.status === 'PAID'));
  assert.ok(llamadas.entregas.every((e) => e.captura.captureId === '123456'));
});

test('rechazar el comprobante rechaza el carrito entero', async () => {
  await yapeDeCarrito();
  const [primera] = [...filas.values()];

  await manualService.rechazar({
    paymentId: primera.id,
    adminId: 'admin-1',
    motivo: 'El importe de la captura no coincide con el total.',
  });

  assert.ok([...filas.values()].every((f) => f.status === 'REJECTED'));
});

// ── Western Union ──────────────────────────────────────────────────────────

test('Western Union cobra en dólares, al precio de PayPal, con su propia referencia', async () => {
  envFalso.westernUnion = { activo: true, beneficiario: 'Acosta', dni: '1', ciudad: 'Trujillo' };
  descuentos.PROMO40 = { id: 'd1', code: 'PROMO40', amountCents: 4000, discountUsdCents: 1100 };

  const suelto = await manualService.registrar({
    userId: 'user-1',
    planCode: 'METODO',
    discountCode: 'PROMO40',
    operationCode: '1234567890',
    buffer: Buffer.from('png'),
    metodo: 'WESTERN_UNION',
  });

  // 45 $ − 11 $ de la rebaja en dólares, no 40 soles.
  assert.equal(suelto.amountCents, 3400);
  assert.equal(suelto.currency, 'USD');
  assert.match(suelto.reference, /^WU-/);
  const fila = filas.get(suelto.paymentId);
  assert.equal(fila.provider, 'WESTERN_UNION');
  assert.equal(fila.discountCents, 1100);
  assert.match(llamadas.avisos[0].titulo, /^Western Union por revisar · US\$ 34\.00/);

  const carro = await manualService.registrarCarrito({
    userId: 'user-1',
    items: [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }],
    operationCode: '1234567890',
    buffer: Buffer.from('png'),
    metodo: 'WESTERN_UNION',
  });
  assert.equal(carro.amountCents, 4500 + 6000);
  assert.equal(carro.currency, 'USD');
});

test('sin beneficiario configurado no se acepta un Western Union', async () => {
  envFalso.westernUnion = { activo: false };

  await assert.rejects(
    manualService.registrar({
      userId: 'user-1',
      planCode: 'METODO',
      operationCode: '1234567890',
      buffer: Buffer.from('png'),
      metodo: 'WESTERN_UNION',
    }),
    /Western Union/,
  );
  assert.equal(filas.size, 0);
  assert.equal(manualService.datosWesternUnion(), null);
});

test('el MTCN es obligatorio en Western Union y son 10 dígitos', () => {
  const { registrarQuerySchema } = require('../src/modules/payments/manual.schema');

  const sinMtcn = registrarQuerySchema.safeParse({ planCode: 'METODO', metodo: 'WESTERN_UNION' });
  assert.equal(sinMtcn.success, false);
  assert.equal(
    registrarQuerySchema.safeParse({ planCode: 'METODO', metodo: 'WESTERN_UNION', operationCode: '12345' })
      .success,
    false,
  );
  const conEspacios = registrarQuerySchema.parse({
    planCode: 'METODO',
    metodo: 'WESTERN_UNION',
    operationCode: '123-456 7890',
  });
  assert.equal(conEspacios.operationCode, '1234567890');
  // Sin método sigue siendo Yape.
  assert.equal(
    registrarQuerySchema.parse({ planCode: 'METODO', operationCode: '01234567' }).metodo,
    'YAPE',
  );
});

test('en Yape el número de operación es obligatorio: solo cifras, de 6 a 12', () => {
  const { registrarQuerySchema } = require('../src/modules/payments/manual.schema');
  const intento = (operationCode) =>
    registrarQuerySchema.safeParse({ planCode: 'METODO', operationCode });

  assert.equal(registrarQuerySchema.safeParse({ planCode: 'METODO' }).success, false);
  assert.equal(intento('').success, false);
  assert.equal(intento('12345').success, false);
  assert.equal(intento('1234567890123').success, false);
  assert.equal(intento('ABC12345').success, false);
  assert.equal(intento('0123 4567').data.operationCode, '01234567');
  assert.equal(intento('123456').success, true);
});

test('la captura se lee antes de abrir el pago y el veredicto queda en todas las filas', async () => {
  await yapeDeCarrito();
  // Se apunta sin esperar: se le da un turno para que termine.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(llamadas.revisiones.length, 1);
  assert.equal(llamadas.revisiones[0].amountCents, 33900);
  assert.equal(llamadas.revisiones[0].operationCode, '123456');
  assert.equal(llamadas.proofChecks.length, 1);
  assert.equal(llamadas.proofChecks[0].ids.length, 2);
  assert.equal(llamadas.proofChecks[0].revision.veredicto, 'OK');
});

// ── Descuento sobre el total ───────────────────────────────────────────────

test('un código general rebaja el TOTAL una vez y se reparte entre las filas', async () => {
  generales.TOTAL50 = { id: 'g1', code: 'TOTAL50', amountCents: 5000, planCode: null };

  const enviado = await manualService.registrarCarrito({
    userId: 'user-1',
    items: [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }],
    discountCode: 'TOTAL50',
    buffer: Buffer.from('png'),
  });

  // 159 + 220 − 50 = 329: cincuenta una vez, no cincuenta por producto.
  assert.equal(enviado.amountCents, 32900);
  assert.deepEqual(enviado.discount, { code: 'TOTAL50', amountCents: 5000 });

  const guardadas = [...filas.values()];
  assert.equal(guardadas.reduce((s, f) => s + f.amountCents, 0), 32900);
  assert.equal(guardadas.reduce((s, f) => s + f.discountCents, 0), 5000);
  // El código queda en UNA fila: gasta un solo uso al entregarse.
  assert.equal(guardadas.filter((f) => f.discountCodeId === 'g1').length, 1);
  assert.ok(enviado.items.every((i) => i.discount === null));
});

test('en PayPal el código del total se cobra en dólares y se suma al de la línea', async () => {
  descuentos.PROMO40 = { id: 'd1', code: 'PROMO40', amountCents: 4000, discountUsdCents: 1100 };
  generales.TOTAL50 = { id: 'g1', code: 'TOTAL50', amountCents: 5000, planCode: null };

  respuestasFetch = [ordenPaypal()];
  const orden = await paymentService.createCartOrder({
    userId: 'user-1',
    items: [{ planCode: 'METODO', discountCode: 'PROMO40' }, { planCode: 'ARTICULO' }],
    discountCode: 'TOTAL50',
    providerCode: 'PAYPAL',
  });

  // Antes del total: 34 + 60 = 94 $ (339 soles). 50 soles son 94·50/339 ≈ 13,86 $.
  assert.equal(orden.discount.amountCents, 1386);
  assert.equal(orden.amountCents, 9400 - 1386);
  const guardadas = [...filas.values()];
  assert.equal(guardadas.reduce((s, f) => s + f.amountCents, 0), orden.amountCents);
  // La línea con su código lo conserva; el del total va a la otra.
  assert.deepEqual(
    guardadas.map((f) => f.discountCodeId),
    ['d1', 'g1'],
  );
  assert.deepEqual(
    orden.items.map((i) => i.discount?.amountCents ?? null),
    [1100, null],
  );
});

test('un código de un producto escrito en el carrito rebaja solo ese producto', async () => {
  descuentos.SOLOART = { id: 'd2', code: 'SOLOART', amountCents: 3000, discountUsdCents: 800, planCode: 'ARTICULO' };

  const enviado = await manualService.registrarCarrito({
    userId: 'user-1',
    items: [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }],
    discountCode: 'SOLOART',
    buffer: Buffer.from('png'),
  });

  assert.equal(enviado.amountCents, 15900 + 22000 - 3000);
  assert.equal(enviado.discount, null);
  assert.deepEqual(
    enviado.items.map((i) => i.discount?.code ?? null),
    [null, 'SOLOART'],
  );
});

test('la ventana comprueba el código del carrito y dice a qué se aplica', async () => {
  const carrito = require('../src/modules/payments/payment.carrito');
  generales.TOTAL50 = { id: 'g1', code: 'TOTAL50', amountCents: 5000, planCode: null };
  descuentos.SOLOART = { id: 'd2', code: 'SOLOART', amountCents: 3000, planCode: 'ARTICULO' };
  const items = [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }];

  const total = await carrito.validarCodigoDelCarrito(items, 'TOTAL50');
  assert.equal(total.alcance, 'TOTAL');
  assert.equal(total.discount.amountCents, 5000);

  const solo = await carrito.validarCodigoDelCarrito(items, 'SOLOART');
  assert.equal(solo.alcance, 'PLAN');
  assert.equal(solo.planCode, 'ARTICULO');
});

// ── Lo que manda el navegador ──────────────────────────────────────────────

test('la query del Yape lleva el carrito como PLAN:CODIGO separados por comas', () => {
  const { registrarQuerySchema } = require('../src/modules/payments/manual.schema');
  const leido = registrarQuerySchema.parse({
    items: 'metodo:PROMO40, articulo',
    operationCode: '01234567',
  });

  assert.deepEqual(leido.items, [
    { planCode: 'METODO', discountCode: 'PROMO40' },
    { planCode: 'ARTICULO' },
  ]);
  assert.equal(registrarQuerySchema.safeParse({ items: 'metodo,METODO' }).success, false);
  assert.equal(registrarQuerySchema.safeParse({}).success, false);
});

test('la orden admite el plan suelto o la lista, nunca los dos', () => {
  const { createOrderSchema } = require('../src/modules/payments/payment.schema');

  assert.equal(createOrderSchema.safeParse({ planCode: 'METODO' }).success, true);
  assert.equal(
    createOrderSchema.safeParse({ items: [{ planCode: 'METODO' }, { planCode: 'ARTICULO' }] })
      .success,
    true,
  );
  assert.equal(
    createOrderSchema.safeParse({ planCode: 'METODO', items: [{ planCode: 'ARTICULO' }] }).success,
    false,
  );
  assert.equal(createOrderSchema.safeParse({ items: [] }).success, false);
});

test('una imagen que no parece un comprobante no abre ningún pago', async () => {
  veredictoDelOcr = 'NO_PARECE';

  await assert.rejects(yapeDeCarrito(), /no parece un comprobante/);
  await assert.rejects(
    manualService.registrar({
      userId: 'user-1',
      planCode: 'METODO',
      operationCode: '01234567',
      buffer: Buffer.from('png'),
    }),
    /no parece un comprobante/,
  );
  assert.equal(filas.size, 0);
  assert.equal(llamadas.avisos.length, 0);
});

test('si el OCR duda o no pudo leer, el pago pasa igual', async () => {
  for (const veredicto of ['DUDOSO', 'SIN_LEER']) {
    veredictoDelOcr = veredicto;
    const enviado = await yapeDeCarrito();
    assert.equal(enviado.status, 'IN_REVIEW');
  }
});
