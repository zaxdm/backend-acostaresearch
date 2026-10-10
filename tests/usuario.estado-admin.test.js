'use strict';

/**
 * El administrador suspende una cuenta o la vuelve a abrir.
 *
 * Lo que se prueba: que cambia el estado y cierra sus sesiones, que nadie se
 * suspende a sí mismo, que una cuenta eliminada no se toca y que repetir el
 * mismo estado no hace nada. La base se sustituye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const estado = { usuario: null, actualizado: null, revocadas: [] };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/users/user.repository', {
  publicSelect: {},
  findById: async () => estado.usuario,
  update: async (id, data) => {
    estado.actualizado = { id, data };
    return { ...estado.usuario, ...data };
  },
});
sustituir('../src/modules/auth/token.repository', {
  revokeAllForUser: async (id) => {
    estado.revocadas.push(id);
  },
});
sustituir('../src/lib/prisma', {});
sustituir('../src/lib/mailer', { sendMail: async () => {} });
sustituir('../src/lib/notify', { avisarAlAdmin: () => {} });

const userService = require('../src/modules/users/user.service');

function empezar(status = 'ACTIVE') {
  estado.usuario = { id: 'u1', email: 'tesista@gmail.com', status };
  estado.actualizado = null;
  estado.revocadas = [];
}

const cambiar = (status, userId = 'u1') =>
  userService.cambiarEstadoPorAdmin({ userId, status, adminId: 'a1' });

test('suspender cambia el estado y cierra sus sesiones', async () => {
  empezar();

  const { user, cambiado } = await cambiar('SUSPENDED');

  assert.equal(cambiado, true);
  assert.equal(user.status, 'SUSPENDED');
  assert.deepEqual(estado.actualizado, { id: 'u1', data: { status: 'SUSPENDED' } });
  assert.deepEqual(estado.revocadas, ['u1']);
});

test('reactivar también cierra las sesiones que quedaran', async () => {
  empezar('SUSPENDED');

  const { user, cambiado } = await cambiar('ACTIVE');

  assert.equal(cambiado, true);
  assert.equal(user.status, 'ACTIVE');
  assert.deepEqual(estado.revocadas, ['u1']);
});

test('nadie se suspende a sí mismo', async () => {
  empezar();

  await assert.rejects(cambiar('SUSPENDED', 'a1'), (error) => error.statusCode === 409);
  assert.equal(estado.actualizado, null);
});

test('una cuenta eliminada por su dueño no se reabre', async () => {
  empezar('DELETED');

  await assert.rejects(cambiar('ACTIVE'), (error) => error.statusCode === 409);
  assert.equal(estado.actualizado, null);
});

test('repetir el mismo estado no toca nada', async () => {
  empezar('SUSPENDED');

  const { cambiado } = await cambiar('SUSPENDED');

  assert.equal(cambiado, false);
  assert.equal(estado.actualizado, null);
  assert.deepEqual(estado.revocadas, []);
});

test('una cuenta que no existe da 404', async () => {
  empezar();
  estado.usuario = null;

  await assert.rejects(cambiar('SUSPENDED'), (error) => error.statusCode === 404);
});
