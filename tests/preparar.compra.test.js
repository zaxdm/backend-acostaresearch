'use strict';

/**
 * Comprar y renovar la membresía de «Preparar documento».
 *
 * Es el camino del dinero, y lo que se fija aquí son las dos formas de
 * equivocarse que le cuestan algo a alguien:
 *
 *   · Renovar emitiendo una membresía NUEVA. El cliente acabaría con dos, el
 *     cupo se contaría sobre una de las dos y la otra no serviría para nada.
 *   · Renovar moviendo la fecha de activación. Las ventanas de treinta días
 *     salen de ahí: moverla el día 20 regalaría un mes de cupo entero en cada
 *     renovación.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

let vigente = null;

falsificar('../src/modules/preparar/preparar.repository', {
  packVigenteDe: async () => vigente,
});

const prepararService = require('../src/modules/preparar/preparar.service');

const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-09-22T10:00:00Z');
const enDias = (n, desde = AHORA) => new Date(desde.getTime() + n * DIA);

const MENSUAL = { id: 'plan-mensual', docsPorMes: 10, durationDays: 30 };
const TRIMESTRAL = { id: 'plan-trimestral', docsPorMes: 10, durationDays: 90 };

test.beforeEach(() => {
  vigente = null;
});

test('la primera compra emite una membresía que empieza hoy', async () => {
  const { data, renovacion } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: MENSUAL },
    AHORA,
  );

  assert.equal(renovacion, undefined);
  assert.deepEqual(data, {
    userId: 'user-1',
    planId: 'plan-mensual',
    docsPorMes: 10,
    activatedAt: AHORA,
    expiresAt: enDias(30),
  });
});

test('la trimestral dura noventa días y da los mismos diez al mes', async () => {
  const { data } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: TRIMESTRAL },
    AHORA,
  );

  assert.deepEqual(data.expiresAt, enDias(90));
  assert.equal(data.docsPorMes, 10);
});

test('renovar alarga la que ya tiene, no emite otra', async () => {
  vigente = {
    id: 'pack-1',
    activatedAt: enDias(-20),
    expiresAt: enDias(10),
    docsPorMes: 10,
  };

  const { data, renovacion } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: MENSUAL },
    AHORA,
  );

  assert.equal(data, undefined);
  assert.equal(renovacion.packId, 'pack-1');
});

test('renovar con margen no le cuesta los días que le quedaban', async () => {
  // Le quedan diez días y renueva por treinta: tiene que acabar con cuarenta.
  vigente = { id: 'pack-1', activatedAt: enDias(-20), expiresAt: enDias(10), docsPorMes: 10 };

  const { renovacion } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: MENSUAL },
    AHORA,
  );

  assert.deepEqual(renovacion.expiresAt, enDias(40));
});

test('una membresía ya caducada se cuenta desde hoy, no desde su caducidad', async () => {
  // Caducó hace un mes. Si se contara desde ahí, pagaría treinta días de los
  // que la mitad ya pasaron.
  vigente = { id: 'pack-1', activatedAt: enDias(-60), expiresAt: enDias(-30), docsPorMes: 10 };

  const { renovacion } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: MENSUAL },
    AHORA,
  );

  assert.deepEqual(renovacion.expiresAt, enDias(30));
});

test('la renovación NO toca la fecha de activación: no regala un mes de cupo', async () => {
  vigente = { id: 'pack-1', activatedAt: enDias(-20), expiresAt: enDias(10), docsPorMes: 10 };

  const { renovacion } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: MENSUAL },
    AHORA,
  );

  assert.equal('activatedAt' in renovacion, false);
});

test('renovar con otro plan trae consigo su cupo, no el de antes', async () => {
  vigente = { id: 'pack-1', activatedAt: enDias(-20), expiresAt: enDias(10), docsPorMes: 10 };

  const { renovacion } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: { ...TRIMESTRAL, docsPorMes: 15 } },
    AHORA,
  );

  assert.equal(renovacion.docsPorMes, 15);
  assert.deepEqual(renovacion.expiresAt, enDias(100));
});

test('un plan sin duración configurada no da una membresía eterna: cae en treinta días', async () => {
  const { data } = await prepararService.prepararParaCompra(
    { userId: 'user-1', plan: { ...MENSUAL, durationDays: 0 } },
    AHORA,
  );

  assert.deepEqual(data.expiresAt, enDias(30));
});
