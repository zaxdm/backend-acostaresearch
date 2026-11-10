'use strict';

/**
 * Cobro mensual automático con Culqi (10-nov-2026).
 *
 * Lo que se fija: solo abre suscripción un cobro con tarjeta, de un plan que se
 * renueva y con la casilla aceptada; la tarjeta se guarda una vez aunque el
 * banco pida 3-D Secure; el plan de Culqi se crea una sola vez; si Culqi falla al
 * suscribir, el cliente no se entera (ya pagó) y queda FALLIDA con aviso; cada
 * cuota se entrega una sola vez y solo si Culqi dice «venta exitosa»; el webhook
 * cree a Culqi y no al cuerpo recibido; y nadie cancela la suscripción de otro.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── Dobles ──────────────────────────────────────────────────────────────────
const db = { suscripciones: [], planes: new Map(), pagos: new Map() };
const llamadas = [];
const culqi = {
  respuestas: {},
  clienteDe: async (d) => (llamadas.push(['cliente', d.email]), 'cus_test_1'),
  guardarTarjeta: async ({ authentication3DS }) => {
    llamadas.push(['tarjeta', Boolean(authentication3DS)]);
    if (culqi.respuestas.tarjeta3DS && !authentication3DS) return { requiresAuthentication: true };
    return { cardId: 'crd_test_1', etiqueta: 'Visa •••• 1111' };
  },
  crearPlanMensual: async (plan) => (llamadas.push(['plan', plan.code]), 'pln_test_1'),
  suscribir: async () => {
    llamadas.push(['suscribir']);
    if (culqi.respuestas.suscribirFalla) {
      const e = new Error('fallo');
      e.body = { merchant_message: 'Plan inválido' };
      throw e;
    }
    return { id: 'sxn_test_1', proximoCobro: new Date('2026-12-10') };
  },
  verSuscripcion: async () => ({ proximoCobro: new Date('2027-01-10'), periodos: [{ charges: [{ id: 'chr_test_B' }] }] }),
  cargo: async (id) => (culqi.respuestas.cargos ?? {})[id] ?? null,
  cancelar: async (id) => (llamadas.push(['cancelar', id]), true),
  evento: async (id) => (culqi.respuestas.eventos ?? {})[id] ?? null,
  etiquetaDeTarjeta: () => '',
};
sustituir('../src/modules/suscripciones/culqi.recurrente', culqi);

const avisos = [];
sustituir('../src/lib/notify', { avisarAlAdmin: (a) => avisos.push(a), avisarAlProgramador: () => {} });

const entregas = [];
sustituir('../src/modules/payments/payment.delivery', {
  entregarPago: async ({ payment, captura }) => {
    entregas.push({ pago: payment.id, cargo: captura.captureId });
    db.pagos.get(payment.providerOrderId).status = 'PAID';
    return { epicuro: {} };
  },
});

sustituir('../src/modules/payments/payment.repository', {
  findByOrderId: async (_p, ref) => db.pagos.get(ref) ?? null,
  create: async (data) => {
    const fila = { id: `pago-${db.pagos.size + 1}`, status: 'PENDING', ...data, plan: { name: 'IA Estándar' }, user: {} };
    db.pagos.set(data.providerOrderId, fila);
    return fila;
  },
});

const coincide = (fila, where) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(fila[k]);
    if (v && typeof v === 'object' && 'not' in v) return fila[k] !== v.not;
    return fila[k] === v;
  });
sustituir('../src/lib/prisma', {
  suscripcion: {
    findUnique: async ({ where, include }) => {
      const f = db.suscripciones.find((s) => coincide(s, where));
      if (!f) return null;
      return include ? { ...f, plan: db.planes.get(f.planId), user: { email: 'ana@gmail.com' } } : f;
    },
    findMany: async ({ where }) => db.suscripciones.filter((s) => coincide(s, where)).map((f) => ({ ...f, plan: db.planes.get(f.planId) })),
    create: async ({ data }) => {
      const f = { id: `sus-${db.suscripciones.length + 1}`, estado: 'PENDIENTE', culqiSubscriptionId: null, ...data };
      db.suscripciones.push(f);
      return f;
    },
    update: async ({ where, data }) => Object.assign(db.suscripciones.find((s) => s.id === where.id), data),
  },
  plan: {
    findUnique: async ({ where }) => [...db.planes.values()].find((p) => p.code === where.code) ?? null,
    findMany: async ({ where }) => [...db.planes.values()].filter((p) => coincide(p, where)),
    update: async ({ where, data }) => Object.assign(db.planes.get(where.id), data),
  },
});

const servicio = require('../src/modules/suscripciones/suscripcion.service');
const { idsDeCargos, primerId } = servicio._internos;

const CULQI = { code: 'CULQI' };
const DATOS = { acepta: true, nombre: 'Ana', apellido: 'Pérez', telefono: '999888777', ciudad: 'Lima', direccion: 'Av. Lima 123' };
const pagoOferta = () => ({
  id: 'pago-oferta',
  userId: 'u1',
  user: { email: 'ana@gmail.com', firstName: 'Ana' },
  plan: { code: 'TESIS_IA', renuevaCon: 'EPICURO_ESTANDAR' },
});

test.beforeEach(() => {
  db.suscripciones.length = 0;
  db.pagos.clear();
  db.planes.clear();
  db.planes.set('plan-ia', { id: 'plan-ia', code: 'EPICURO_ESTANDAR', name: 'IA Estándar', priceCents: 9990, culqiPlanId: null });
  llamadas.length = 0;
  avisos.length = 0;
  entregas.length = 0;
  culqi.respuestas = {};
});

test('solo abre suscripción: Culqi, tarjeta, plan que se renueva y casilla aceptada', () => {
  const payment = pagoOferta();
  const conTarjeta = { token: 'tkn_test_abc', suscripcion: DATOS };
  assert.equal(servicio.aplica({ provider: CULQI, payment, datosDelCobro: conTarjeta }), true);
  assert.equal(servicio.aplica({ provider: CULQI, payment, datosDelCobro: { ...conTarjeta, token: 'ype_test_x' } }), false);
  assert.equal(servicio.aplica({ provider: CULQI, payment, datosDelCobro: { token: 'tkn_test_abc' } }), false);
  assert.equal(servicio.aplica({ provider: { code: 'PAYPAL' }, payment, datosDelCobro: conTarjeta }), false);
  assert.equal(servicio.aplica({ provider: CULQI, payment: { ...payment, cartId: 'c1' }, datosDelCobro: conTarjeta }), false);
  assert.equal(
    servicio.aplica({ provider: CULQI, payment: { ...payment, plan: { code: 'X' } }, datosDelCobro: conTarjeta }),
    false,
  );
});

test('la tarjeta se guarda una vez; con 3-D Secure se repite y no se duplica la fila', async () => {
  culqi.respuestas.tarjeta3DS = true;
  const payment = pagoOferta();
  const primera = await servicio.prepararTarjeta({ payment, token: 'tkn_test_abc', suscripcion: DATOS });
  assert.deepEqual(primera, { requiresAuthentication: true });
  assert.equal(db.suscripciones.length, 0);

  const segunda = await servicio.prepararTarjeta({
    payment,
    token: 'tkn_test_abc',
    suscripcion: DATOS,
    authentication3DS: { eci: '05' },
  });
  assert.equal(segunda.cardId, 'crd_test_1');
  assert.equal(db.suscripciones.length, 1);
  assert.equal(db.suscripciones[0].planId, 'plan-ia');
  assert.equal(db.suscripciones[0].tarjeta, 'Visa •••• 1111');

  // El cargo pidió 3DS después: vuelve y reutiliza la tarjeta sin llamar a Culqi.
  const antes = llamadas.length;
  const tercera = await servicio.prepararTarjeta({ payment, token: 'tkn_test_abc', suscripcion: DATOS });
  assert.equal(tercera.cardId, 'crd_test_1');
  assert.equal(llamadas.length, antes);
});

test('activar crea el plan de Culqi una sola vez y deja la suscripción ACTIVA', async () => {
  for (const id of ['p1', 'p2']) {
    await servicio.prepararTarjeta({ payment: { ...pagoOferta(), id }, token: 'tkn_test_abc', suscripcion: DATOS });
    await servicio.activar(id);
  }
  assert.equal(llamadas.filter(([q]) => q === 'plan').length, 1);
  assert.equal(db.planes.get('plan-ia').culqiPlanId, 'pln_test_1');
  assert.ok(db.suscripciones.every((s) => s.estado === 'ACTIVA' && s.culqiSubscriptionId === 'sxn_test_1'));
});

test('si Culqi no suscribe, no lanza: queda FALLIDA con el motivo y avisa', async () => {
  culqi.respuestas.suscribirFalla = true;
  await servicio.prepararTarjeta({ payment: pagoOferta(), token: 'tkn_test_abc', suscripcion: DATOS });
  const fila = await servicio.activar('pago-oferta');
  assert.equal(fila.estado, 'FALLIDA');
  assert.match(fila.ultimoError, /Plan inválido/);
  assert.equal(avisos.length, 1);
});

test('cada cuota se entrega una sola vez y solo si Culqi dice venta exitosa', async () => {
  const fila = { id: 's1', userId: 'u1', planId: 'plan-ia', plan: db.planes.get('plan-ia') };
  db.suscripciones.push({ ...fila, estado: 'ACTIVA' });
  culqi.respuestas.cargos = {
    chr_test_A: { id: 'chr_test_A', amount: 9990, currency_code: 'PEN', outcome: { type: 'venta_exitosa' } },
    chr_test_X: { id: 'chr_test_X', amount: 9990, outcome: { type: 'venta_denegada' } },
  };
  assert.equal((await servicio.registrarCobro(fila, 'chr_test_A')).resultado, 'entregado');
  assert.equal((await servicio.registrarCobro(fila, 'chr_test_A')).resultado, 'ya_entregado');
  assert.equal((await servicio.registrarCobro(fila, 'chr_test_X')).resultado, 'no_cobrado');
  assert.equal((await servicio.registrarCobro(fila, 'chr_test_falso')).resultado, 'no_cobrado');
  assert.deepEqual(entregas, [{ pago: 'pago-1', cargo: 'chr_test_A' }]);
  assert.equal(db.pagos.get('cq_sxn_chr_test_A').amountCents, 9990);
});

test('el webhook lee el evento de Culqi y no cree en el cuerpo recibido', async () => {
  db.suscripciones.push({ id: 's1', userId: 'u1', planId: 'plan-ia', estado: 'ACTIVA', culqiSubscriptionId: 'sxn_test_1' });
  culqi.respuestas.cargos = { chr_test_A: { id: 'chr_test_A', amount: 9990, outcome: { type: 'venta_exitosa' } } };

  // Alguien manda un cuerpo inventado: el evento no existe en Culqi.
  assert.equal((await servicio.webhook({ id: 'evt_test_falso', type: 'subscription.charge.succeeded' })).resultado, 'ignorado');
  assert.equal(entregas.length, 0);

  culqi.respuestas.eventos = {
    evt_test_1: { type: 'subscription.charge.succeeded', data: JSON.stringify({ subscription_id: 'sxn_test_1', charge: { id: 'chr_test_A' } }) },
    evt_test_2: { type: 'subscription.cancel.succeeded', data: { id: 'sxn_test_1' } },
    evt_test_3: { type: 'charge.creation.succeeded', data: {} },
  };
  assert.equal((await servicio.webhook({ id: 'evt_test_1' })).resultado, 'cobrado');
  assert.equal(entregas.length, 1);
  assert.equal((await servicio.webhook({ id: 'evt_test_3' })).resultado, 'ignorado');
  assert.equal((await servicio.webhook({ id: 'evt_test_2' })).resultado, 'cancelada');
  assert.equal(db.suscripciones[0].estado, 'CANCELADA');
});

test('nadie cancela la suscripción de otro; la propia se corta en Culqi', async () => {
  db.suscripciones.push({ id: 's1', userId: 'u1', planId: 'plan-ia', estado: 'ACTIVA', culqiSubscriptionId: 'sxn_test_1' });
  await assert.rejects(servicio.cancelar({ userId: 'otro', id: 's1' }), /No encontramos/);
  assert.equal(llamadas.length, 0);
  await servicio.cancelar({ userId: 'u1', id: 's1' });
  assert.deepEqual(llamadas, [['cancelar', 'sxn_test_1']]);
  assert.equal(db.suscripciones[0].estado, 'CANCELADA');
  assert.ok(db.suscripciones[0].canceladaEn instanceof Date);
});

test('la conciliación recupera las cuotas que el webhook no trajo', async () => {
  const fila = { id: 's1', userId: 'u1', planId: 'plan-ia', estado: 'ACTIVA', culqiSubscriptionId: 'sxn_test_1' };
  db.suscripciones.push(fila);
  culqi.respuestas.cargos = { chr_test_B: { id: 'chr_test_B', amount: 9990, outcome: { type: 'venta_exitosa' } } };
  const r = await servicio.conciliarTodas();
  assert.equal(r.revisadas, 1);
  assert.deepEqual(entregas.map((e) => e.cargo), ['chr_test_B']);
  assert.equal(db.suscripciones[0].proximoCobro.toISOString().slice(0, 10), '2027-01-10');
});

test('encuentra ids de Culqi a cualquier profundidad', () => {
  assert.deepEqual([...idsDeCargos({ a: [{ b: 'chr_live_X1' }, 'x chr_test_Y2 y'] })], ['chr_live_X1', 'chr_test_Y2']);
  assert.equal(primerId('{"s":"sxn_live_AbC"}', 'sxn'), 'sxn_live_AbC');
  assert.equal(primerId({ nada: 1 }, 'sxn'), null);
});

test('los planes mensuales se crean en Culqi una sola vez, sin esperar a la primera venta', async () => {
  db.planes.get('plan-ia').renuevaCon = 'EPICURO_ESTANDAR';
  db.planes.set('plan-oferta', { id: 'plan-oferta', code: 'TESIS_IA', renuevaCon: 'EPICURO_ESTANDAR', culqiPlanId: null });
  db.planes.set('plan-power', { id: 'plan-power', code: 'EPICURO_POWER', renuevaCon: 'EPICURO_POWER', culqiPlanId: 'pln_ya' });

  const primera = await servicio.planesEnCulqi();
  assert.deepEqual(primera.find((p) => p.code === 'EPICURO_ESTANDAR'), { code: 'EPICURO_ESTANDAR', culqiPlanId: 'pln_test_1', nuevo: true });
  assert.deepEqual(primera.find((p) => p.code === 'EPICURO_POWER'), { code: 'EPICURO_POWER', culqiPlanId: 'pln_ya', nuevo: false });
  assert.equal(primera.length, 2, 'la oferta no es un plan mensual: no se crea en Culqi');

  await servicio.planesEnCulqi();
  assert.deepEqual(llamadas.filter((l) => l[0] === 'plan'), [['plan', 'EPICURO_ESTANDAR']]);
});
