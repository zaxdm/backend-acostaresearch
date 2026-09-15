'use strict';

/**
 * Los cinco intentos del código de verificación son cinco.
 *
 * Se leía la cuenta, se comparaba y se incrementaba: tres pasos. Con peticiones
 * en paralelo cabían más de cinco intentos contra el mismo código de seis
 * cifras, que es justo el freno que impide adivinarlo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const filas = new Map();
const turno = () => new Promise((resuelve) => setImmediate(resuelve));

const prismaFalso = {
  pendingRegistration: {
    async updateMany({ where, data }) {
      await turno();
      const fila = filas.get(where.id);
      if (!fila) return { count: 0 };
      if (where.attempts?.lt !== undefined && !(fila.attempts < where.attempts.lt)) {
        return { count: 0 };
      }
      if (data.attempts?.increment) fila.attempts += data.attempts.increment;
      return { count: 1 };
    },
    async findUnique({ where }) {
      await turno();
      const fila = filas.get(where.id);
      return fila ? { ...fila } : null;
    },
  },
};

const rutaPrisma = require.resolve('../src/lib/prisma');
require.cache[rutaPrisma] = { id: rutaPrisma, filename: rutaPrisma, loaded: true, exports: prismaFalso };

const pendientes = require('../src/modules/auth/pendingRegistration.repository');

const MAXIMO = 5;

test.beforeEach(() => {
  filas.clear();
  filas.set('p1', { id: 'p1', attempts: 0 });
});

test('diez intentos fallidos a la vez suman cinco, no diez', async () => {
  const resultados = await Promise.all(
    Array.from({ length: 10 }, () => pendientes.registerFailedAttempt('p1', MAXIMO)),
  );

  assert.equal(filas.get('p1').attempts, MAXIMO);
  // Solo cinco se llevan un intento; las otras cinco se encuentran el cupo lleno.
  assert.equal(resultados.filter((r) => r.sumado).length, MAXIMO);
  assert.equal(resultados.filter((r) => !r.sumado).length, MAXIMO);
});

test('uno detrás de otro: el quinto agota y el sexto ya no suma', async () => {
  for (let i = 0; i < MAXIMO; i += 1) await pendientes.registerFailedAttempt('p1', MAXIMO);
  assert.equal(filas.get('p1').attempts, MAXIMO);

  const sexto = await pendientes.registerFailedAttempt('p1', MAXIMO);
  assert.equal(sexto.agotado, true);
  assert.equal(filas.get('p1').attempts, MAXIMO);
});
