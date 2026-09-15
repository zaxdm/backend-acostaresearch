'use strict';

/**
 * El tope de usos de un código de descuento, también cuando llegan a la vez.
 *
 * El tope se miraba al crear la orden y se sumaba al liquidar el pago. Entre
 * las dos cosas caben horas: un código de un solo uso con diez Yapes abiertos
 * a la vez acababa con `usedCount` en diez. Lo que se fija aquí es que la
 * comprobación y la suma son UNA sola operación.
 *
 * La base es falsa, pero se comporta en lo que importa como MySQL: cada
 * `updateMany` evalúa su condición y escribe sin que nadie se cuele en medio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const filas = new Map();

/** Cede el turno, para que las llamadas simultáneas se intercalen de verdad. */
const turno = () => new Promise((resuelve) => setImmediate(resuelve));

/** La marca que usa el servicio para comparar una columna con otra. */
const REFERENCIA_MAX_USES = { __campo: 'maxUses' };

function cumpleUna(fila, where) {
  return Object.entries(where).every(([campo, condicion]) => {
    if (campo === 'OR') return condicion.some((parte) => cumpleUna(fila, parte));
    const valor = fila[campo];
    if (condicion === null || typeof condicion !== 'object') return valor === condicion;
    if ('lt' in condicion) {
      // El servicio compara `usedCount` con la COLUMNA `maxUses`, no con un número.
      const tope =
        condicion.lt === REFERENCIA_MAX_USES ? fila.maxUses : condicion.lt;
      return valor < tope;
    }
    return true;
  });
}

const prismaFalso = {
  discountCode: {
    fields: { maxUses: REFERENCIA_MAX_USES },
    async updateMany({ where, data }) {
      await turno();
      const fila = filas.get(where.id);
      if (!fila || !cumpleUna(fila, where)) return { count: 0 };
      if (data.usedCount?.increment) fila.usedCount += data.usedCount.increment;
      return { count: 1 };
    },
  },
};

const rutaPrisma = require.resolve('../src/lib/prisma');
require.cache[rutaPrisma] = { id: rutaPrisma, filename: rutaPrisma, loaded: true, exports: prismaFalso };

const rutaLogger = require.resolve('../src/config/logger');
const avisos = [];
require.cache[rutaLogger] = {
  id: rutaLogger,
  filename: rutaLogger,
  loaded: true,
  exports: { info() {}, warn: (datos, mensaje) => avisos.push(mensaje), error() {} },
};

const descuentos = require('../src/modules/billing/discount.service');

test.beforeEach(() => {
  filas.clear();
  avisos.length = 0;
});

test('un código de un solo uso, cobrado diez veces a la vez, se gasta una sola vez', async () => {
  filas.set('d1', { id: 'd1', maxUses: 1, usedCount: 0 });

  const resultados = await Promise.all(
    Array.from({ length: 10 }, () => descuentos.registrarUso('d1')),
  );

  assert.equal(filas.get('d1').usedCount, 1);
  assert.equal(resultados.filter(Boolean).length, 1);
});

test('el que llega con el código ya agotado no rompe la entrega, pero queda avisado', async () => {
  filas.set('d2', { id: 'd2', maxUses: 1, usedCount: 1 });

  assert.equal(await descuentos.registrarUso('d2'), false);
  assert.equal(filas.get('d2').usedCount, 1);
  assert.match(avisos.join(' '), /agotado/);
});

test('un código sin tope (maxUses = 0) se sigue pudiendo usar siempre', async () => {
  filas.set('d3', { id: 'd3', maxUses: 0, usedCount: 7 });

  await Promise.all(Array.from({ length: 5 }, () => descuentos.registrarUso('d3')));

  assert.equal(filas.get('d3').usedCount, 12);
});
