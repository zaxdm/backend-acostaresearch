'use strict';

/**
 * Canjear un código que vende una membresía de «Preparar documento».
 *
 * Un código de activación entregaba SIEMPRE una licencia del conector. Desde
 * que las membresías de documentos también se venden por WhatsApp, el mismo
 * código puede vender dos cosas distintas, y equivocarse aquí es caro en las
 * dos direcciones:
 *
 *   · entregar un conector a quien compró documentos le deja una URL que no
 *     abre nada y sin lo que pagó;
 *   · marcar el código como gastado sin crear la membresía le deja sin código
 *     y sin membresía, y no hay forma de que lo arregle él solo.
 *
 * La base, el correo y los módulos de «Preparar documento» se sustituyen antes
 * de cargar nada: lo que se comprueba es qué se entrega y qué se apunta.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── Lo que contesta la base ─────────────────────────────────────────────────

const PLAN_MENSUAL = {
  id: 'plan-preparar-mensual',
  code: 'PREPARAR_MENSUAL',
  name: 'Preparar documento · mensual',
  priceCents: 2900,
  durationDays: 30,
  docsPorMes: 10,
};

/** El plan de licencia que encuentra `contratoDelProducto`, o null. */
let planDeLicencia = null;
/** El plan de documentos que encuentra `planDeMembresia`, o null. */
let planDeDocumentos = PLAN_MENSUAL;

const correos = [];

sustituir('../src/lib/prisma', {
  plan: {
    findFirst: async ({ where }) =>
      where.kind === 'DOCUMENTO' ? planDeDocumentos : planDeLicencia,
  },
  user: {
    findUnique: async () => ({ email: 'ana@example.com', firstName: 'Ana' }),
  },
});

sustituir('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    correos.push(mensaje);
    return { messageId: 'x' };
  },
});

// ── Lo que se entrega ───────────────────────────────────────────────────────

/** Lo que llegó a `redeemCon`, para poder mirarlo desde las pruebas. */
const canje = { llamadas: [], disponible: true };
/** Los packs creados y alargados, con lo que se les pasó. */
const packs = { creados: [], alargados: [] };

sustituir('../src/modules/licensing/license.repository', {
  findCodeByHash: async () => registro,
  async redeemCon({ codeId, userId, entregar, pago }) {
    canje.llamadas.push({ codeId, userId, pago });
    // Como el de verdad: si el código ya no está disponible, no se entrega nada.
    if (!canje.disponible) return null;
    const { fila, enlace } = await entregar({});
    canje.llamadas.at(-1).enlace = enlace;
    return fila;
  },
  redeem: async () => assert.fail('una membresía no emite licencia'),
});

sustituir('../src/modules/preparar/preparar.repository', {
  crearPack: async (data) => {
    packs.creados.push(data);
    return { id: 'pack-1', ...data };
  },
  extenderPack: async (id, cambios) => {
    packs.alargados.push({ id, ...cambios });
    return { id, ...cambios, docsPorMes: cambios.docsPorMes };
  },
});

/** Lo que decide alta o renovación. Se cambia en cada prueba. */
let preparada = null;

sustituir('../src/modules/preparar/preparar.service', {
  prepararParaCompra: async () => preparada,
});

const licenseService = require('../src/modules/licensing/license.service');

// ── El código que se canjea ────────────────────────────────────────────────

let registro = null;

const FECHA = new Date('2026-10-22T12:00:00Z');

function codigo(extra = {}) {
  return {
    id: 'codigo-1',
    hint: 'K7P2',
    productCode: 'PREPARAR_MENSUAL',
    status: 'AVAILABLE',
    buyerEmail: 'ana@example.com',
    note: 'Yape 22 sep',
    createdById: 'admin-1',
    createdAt: new Date('2026-09-22T12:00:00Z'),
    paymentMethod: 'YAPE',
    paymentRef: 'OP-4471',
    amountCents: 2900,
    expiresAt: null,
    ...extra,
  };
}

function empezar() {
  registro = codigo();
  planDeLicencia = null;
  planDeDocumentos = PLAN_MENSUAL;
  canje.llamadas.length = 0;
  canje.disponible = true;
  packs.creados.length = 0;
  packs.alargados.length = 0;
  correos.length = 0;
  preparada = {
    data: {
      userId: 'u1',
      planId: PLAN_MENSUAL.id,
      docsPorMes: 10,
      activatedAt: FECHA,
      expiresAt: new Date('2026-11-21T12:00:00Z'),
    },
  };
}

// ── Las pruebas ─────────────────────────────────────────────────────────────

test('el código de una membresía entrega documentos, no una URL de conector', async () => {
  empezar();

  const resultado = await licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });

  assert.equal(resultado.connectorUrl, undefined, 'una membresía no tiene nada que pegar en Claude');
  assert.equal(resultado.license, undefined);
  assert.equal(resultado.membresia.docsPorMes, 10);
  assert.equal(resultado.membresia.plan.name, 'Preparar documento · mensual');
  assert.equal(resultado.renovada, false);
  assert.equal(packs.creados.length, 1);
});

test('el pack guarda de dónde salió el dinero, para poder cuadrarlo después', async () => {
  empezar();
  await licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });

  const [pack] = packs.creados;
  assert.equal(pack.paymentMethod, 'YAPE');
  assert.equal(pack.paymentRef, 'OP-4471');
  assert.equal(pack.amountCents, 2900);
  assert.equal(pack.note, 'Yape 22 sep');
  assert.equal(pack.grantedById, 'admin-1');
});

test('el cobro se apunta contra el plan de la membresía y cuelga de su pack', async () => {
  empezar();
  await licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });

  const [llamada] = canje.llamadas;
  assert.equal(llamada.pago.planId, PLAN_MENSUAL.id);
  assert.equal(llamada.pago.amountCents, 2900);
  assert.equal(llamada.pago.status, 'PAID');
  assert.equal(llamada.pago.provider, 'YAPE');
  // El pago se engancha al pack, no a una licencia que aquí no existe.
  assert.deepEqual(llamada.enlace, { docPackId: 'pack-1' });
});

test('una cortesía entrega la membresía y no apunta ningún cobro', async () => {
  empezar();
  registro = codigo({ paymentMethod: 'CORTESIA', amountCents: null, paymentRef: null });

  const resultado = await licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });

  assert.equal(resultado.membresia.docsPorMes, 10);
  assert.equal(canje.llamadas[0].pago, null);
});

test('quien ya tiene membresía la alarga, en vez de quedarse con dos', async () => {
  empezar();
  preparada = {
    renovacion: {
      packId: 'pack-viejo',
      expiresAt: new Date('2026-12-21T12:00:00Z'),
      docsPorMes: 10,
    },
  };

  const resultado = await licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });

  assert.equal(resultado.renovada, true);
  assert.equal(packs.creados.length, 0, 'con dos membresías el cupo se contaría sobre una sola');
  assert.deepEqual(packs.alargados[0].id, 'pack-viejo');
});

test('avisa por correo de la membresía, no de una licencia', async () => {
  empezar();
  await licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });

  assert.equal(correos.length, 1);
  assert.match(correos[0].subject, /membresía/i);
  assert.match(correos[0].text, /activado tu código/i);
  assert.match(correos[0].text, /10 documentos al mes/);
  assert.doesNotMatch(correos[0].text, /conector/i);
});

test('si otro canjeó el código un instante antes, no se entrega nada', async () => {
  empezar();
  canje.disponible = false;

  await assert.rejects(
    licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' }),
    /no es válido o ya se usó/,
  );
  assert.equal(correos.length, 0, 'no se avisa de una membresía que no se creó');
});

test('un código ya gastado o anulado no llega a tocar la membresía', async () => {
  for (const status of ['REDEEMED', 'VOID']) {
    empezar();
    registro = codigo({ status });
    await assert.rejects(
      licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' }),
      /no es válido o ya se usó/,
    );
    assert.equal(packs.creados.length, 0, status);
  }
});

test('un código caducado se explica, y tampoco entrega', async () => {
  empezar();
  registro = codigo({ expiresAt: new Date('2020-01-01T00:00:00Z') });

  await assert.rejects(
    licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' }),
    /caducó/,
  );
  assert.equal(packs.creados.length, 0);
});

test('un producto sin plan de licencia ni de documentos sigue el camino de siempre', async () => {
  empezar();
  planDeDocumentos = null;
  registro = codigo({ productCode: 'LO_QUE_SEA' });

  // El camino de la licencia usa `redeem`, que en esta prueba falla a propósito:
  // lo que se comprueba es que NO se desvía por el de la membresía.
  await assert.rejects(
    licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' }),
    /una membresía no emite licencia/,
  );
  assert.equal(packs.creados.length, 0);
});
