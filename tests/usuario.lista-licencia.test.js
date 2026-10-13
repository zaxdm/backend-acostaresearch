'use strict';

/**
 * La lista de cuentas del panel, cribada por si tienen licencia.
 *
 * Lo que se prueba: qué `where` llega a la base con «con», con «sin» y sin
 * criba, que al administrador de país solo le cuentan las licencias de su país
 * y que el conteo de las pestañas sale sin la criba. La base se sustituye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pedidos = { lista: null, cuentas: [] };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/lib/prisma', {
  user: {
    findMany: async (args) => {
      pedidos.lista = args;
      return [{ id: 'u1' }];
    },
    count: async ({ where }) => {
      pedidos.cuentas.push(where);
      // Total de la página, todos y con licencia, en ese orden.
      return [7, 10, 4][pedidos.cuentas.length - 1];
    },
  },
});

const userRepository = require('../src/modules/users/user.repository');

function empezar() {
  pedidos.lista = null;
  pedidos.cuentas = [];
}

test('sin criba salen todas las cuentas, menos los invitados de prueba', async () => {
  empezar();
  const { conteo } = await userRepository.paginate({ page: 1, perPage: 50 });

  assert.deepEqual(pedidos.lista.where, { trialLinkId: null });
  assert.deepEqual(conteo, { todos: 10, con: 4, sin: 6 });
});

test('«con» pide las que tienen alguna licencia, y «sin» las que no', async () => {
  empezar();
  await userRepository.paginate({ page: 1, perPage: 50, licencia: 'con' });
  assert.deepEqual(pedidos.lista.where, {
    trialLinkId: null,
    AND: [{ licenses: { some: {} } }],
  });

  empezar();
  await userRepository.paginate({ page: 1, perPage: 50, licencia: 'sin' });
  assert.deepEqual(pedidos.lista.where, {
    trialLinkId: null,
    NOT: { licenses: { some: {} } },
  });
});

test('la búsqueda se mantiene con la criba, y el conteo sale sin ella', async () => {
  empezar();
  await userRepository.paginate({ page: 2, perPage: 50, search: 'ana', licencia: 'sin' });

  assert.equal(pedidos.lista.where.OR.length, 3);
  assert.deepEqual(pedidos.lista.where.NOT, { licenses: { some: {} } });
  assert.equal(pedidos.lista.skip, 50);
  // «Todos» cuenta con la búsqueda y sin la criba.
  assert.equal(pedidos.cuentas[1].NOT, undefined);
  assert.equal(pedidos.cuentas[1].OR.length, 3);
});

test('al administrador de país solo le cuentan las licencias de su país', async () => {
  empezar();
  await userRepository.paginate({ page: 1, perPage: 50, licencia: 'con', paisDeLicencias: 'EC' });

  assert.deepEqual(pedidos.lista.where.AND, [{ licenses: { some: {} }, pais: 'EC' }]);
});
