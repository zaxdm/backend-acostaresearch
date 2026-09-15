'use strict';

/**
 * Las palabras del humanizador no se pueden gastar dos veces.
 *
 * Se descontaba con un `update` a secas después de leer la bolsa: dos
 * reescrituras a la vez leían las mismas `wordsUsed` y la segunda escribía
 * encima. La bolsa gastaba el doble de lo que descontaba, y el límite de cinco
 * por minuto deja sitio de sobra para que eso pase.
 *
 * También se prueba la devolución, que es lo que mantiene la promesa de
 * siempre: lo que no sale, no se cobra.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bolsas = new Map();
const turno = () => new Promise((resuelve) => setImmediate(resuelve));

const prismaFalso = {
  $transaction: (trabajo) => trabajo(prismaFalso),
  wordPack: {
    async findMany({ where, orderBy }) {
      await turno();
      const ahora = new Date();
      const lista = [...bolsas.values()].filter((b) => {
        if (b.userId !== where.userId) return false;
        if (where.status && b.status !== where.status) return false;
        if (where.expiresAt?.gt && !(b.expiresAt > ahora)) return false;
        if (where.wordsUsed?.gt !== undefined && !(b.wordsUsed > where.wordsUsed.gt)) return false;
        return true;
      });
      const campo = Object.keys(orderBy ?? {})[0];
      const sentido = campo ? orderBy[campo] : 'asc';
      if (campo) lista.sort((a, b) => (sentido === 'asc' ? a[campo] - b[campo] : b[campo] - a[campo]));
      return lista.map((b) => ({ ...b }));
    },
    async findUnique({ where }) {
      await turno();
      const bolsa = bolsas.get(where.id);
      return bolsa ? { ...bolsa } : null;
    },
    async updateMany({ where, data }) {
      await turno();
      const bolsa = bolsas.get(where.id);
      if (!bolsa || bolsa.wordsUsed !== where.wordsUsed) return { count: 0 };
      Object.assign(bolsa, data);
      return { count: 1 };
    },
  },
};

const rutaPrisma = require.resolve('../src/lib/prisma');
require.cache[rutaPrisma] = { id: rutaPrisma, filename: rutaPrisma, loaded: true, exports: prismaFalso };

const billing = require('../src/modules/billing/billing.repository');

const MANANA = new Date(Date.now() + 24 * 60 * 60 * 1000);

function bolsa(id, { total, usadas = 0, expira = MANANA } = {}) {
  bolsas.set(id, {
    id,
    userId: 'u1',
    status: 'ACTIVE',
    wordsTotal: total,
    wordsUsed: usadas,
    expiresAt: expira,
  });
}

test.beforeEach(() => bolsas.clear());

test('cinco reescrituras a la vez no gastan más palabras de las que hay', async () => {
  bolsa('b1', { total: 6000 });

  const tomadas = await Promise.all(
    Array.from({ length: 5 }, () => billing.consumeWords('u1', 3000)),
  );

  const gastadas = tomadas.reduce((suma, n) => suma + n, 0);
  assert.equal(bolsas.get('b1').wordsUsed, gastadas, 'lo descontado tiene que cuadrar con lo entregado');
  assert.ok(gastadas <= 6000, `entregó ${gastadas} de 6000`);
  assert.equal(bolsas.get('b1').status, 'EXHAUSTED');
});

test('lo que no cabe no se entrega, y lo poco tomado se puede devolver', async () => {
  bolsa('b1', { total: 1000 });

  const tomadas = await billing.consumeWords('u1', 2500);
  assert.equal(tomadas, 1000);

  const devueltas = await billing.devolverPalabras('u1', tomadas);
  assert.equal(devueltas, 1000);
  assert.equal(bolsas.get('b1').wordsUsed, 0);
  assert.equal(bolsas.get('b1').status, 'ACTIVE');
});

test('se gasta primero la bolsa que antes caduca, y se devuelve a la que más dura', async () => {
  bolsa('pronto', { total: 1000, expira: new Date(Date.now() + 60 * 60 * 1000) });
  bolsa('tarde', { total: 1000, expira: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });

  await billing.consumeWords('u1', 1500);
  assert.equal(bolsas.get('pronto').wordsUsed, 1000);
  assert.equal(bolsas.get('tarde').wordsUsed, 500);

  await billing.devolverPalabras('u1', 500);
  assert.equal(bolsas.get('tarde').wordsUsed, 0);
  assert.equal(bolsas.get('pronto').wordsUsed, 1000);
});
