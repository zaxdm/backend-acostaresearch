'use strict';

/**
 * El dueño le da a una cuenta que ya existe acceso de administrador, o se lo
 * quita.
 *
 * Lo que se prueba: que cambia el rol y cierra sus sesiones, que con país queda
 * de ese país, qué pasa con la etiqueta de país en cada sentido, que nadie se
 * cambia el rol a sí mismo, que una cuenta eliminada no se toca y que repetir
 * lo mismo no hace nada. La base se sustituye.
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
const { cambiarRolSchema } = require('../src/modules/users/user.schema');
const { abiertaAlPais } = require('../src/middlewares/panelDePais');

function empezar(cuenta = {}) {
  estado.usuario = {
    id: 'u1',
    email: 'tesista@gmail.com',
    status: 'ACTIVE',
    role: 'USER',
    pais: null,
    ...cuenta,
  };
  estado.actualizado = null;
  estado.revocadas = [];
}

const cambiar = (role, pais, userId = 'u1') =>
  userService.cambiarRolPorAdmin({ userId, role, pais, adminId: 'a1' });

test('un cliente pasa a administrador general y se le cierran las sesiones', async () => {
  empezar();

  const { user, cambiado } = await cambiar('ADMIN');

  assert.equal(cambiado, true);
  assert.equal(user.role, 'ADMIN');
  assert.deepEqual(estado.actualizado, { id: 'u1', data: { role: 'ADMIN' } });
  assert.deepEqual(estado.revocadas, ['u1']);
});

test('con país queda como administrador de ese país', async () => {
  empezar();

  const { user } = await cambiar('ADMIN', 'EC');

  assert.equal(user.role, 'ADMIN_PAIS');
  assert.deepEqual(estado.actualizado.data, { role: 'ADMIN_PAIS', pais: 'EC' });
});

test('un cliente de un país que pasa a administrador general conserva su etiqueta', async () => {
  empezar({ pais: 'EC' });

  await cambiar('ADMIN');

  assert.deepEqual(estado.actualizado.data, { role: 'ADMIN' });
});

test('quitarle el acceso a uno de país le quita también la etiqueta', async () => {
  empezar({ role: 'ADMIN_PAIS', pais: 'EC' });

  const { user } = await cambiar('USER');

  assert.equal(user.role, 'USER');
  assert.deepEqual(estado.actualizado.data, { role: 'USER', pais: null });
  assert.deepEqual(estado.revocadas, ['u1']);
});

test('uno de país que pasa a general deja de tener país', async () => {
  empezar({ role: 'ADMIN_PAIS', pais: 'EC' });

  await cambiar('ADMIN');

  assert.deepEqual(estado.actualizado.data, { role: 'ADMIN', pais: null });
});

test('cambiarle el país a uno de país sí es un cambio', async () => {
  empezar({ role: 'ADMIN_PAIS', pais: 'EC' });

  const { cambiado } = await cambiar('ADMIN', 'CO');

  assert.equal(cambiado, true);
  assert.deepEqual(estado.actualizado.data, { role: 'ADMIN_PAIS', pais: 'CO' });
});

test('repetir lo mismo no toca nada ni cierra sesiones', async () => {
  empezar({ role: 'ADMIN_PAIS', pais: 'EC' });
  assert.equal((await cambiar('ADMIN', 'EC')).cambiado, false);

  empezar({ role: 'ADMIN' });
  assert.equal((await cambiar('ADMIN')).cambiado, false);

  empezar();
  assert.equal((await cambiar('USER')).cambiado, false);

  assert.equal(estado.actualizado, null);
  assert.deepEqual(estado.revocadas, []);
});

test('nadie se cambia el rol a sí mismo', async () => {
  empezar({ role: 'ADMIN' });

  await assert.rejects(cambiar('USER', undefined, 'a1'), (error) => error.statusCode === 409);
  assert.equal(estado.actualizado, null);
});

test('una cuenta eliminada por su dueño no se toca', async () => {
  empezar({ status: 'DELETED' });

  await assert.rejects(cambiar('ADMIN'), (error) => error.statusCode === 409);
  assert.equal(estado.actualizado, null);
});

test('una cuenta que no existe da 404', async () => {
  empezar();
  estado.usuario = null;

  await assert.rejects(cambiar('ADMIN'), (error) => error.statusCode === 404);
});

test('el rol de país no se manda por su nombre, y el país va en dos letras', () => {
  assert.equal(cambiarRolSchema.safeParse({ role: 'ADMIN_PAIS' }).success, false);
  assert.equal(cambiarRolSchema.safeParse({ role: 'ADMIN', pais: 'Ecuador' }).success, false);
  assert.equal(cambiarRolSchema.parse({ role: 'ADMIN', pais: 'ec' }).pais, 'EC');
  assert.equal('pais' in cambiarRolSchema.parse({ role: 'USER' }), false);
});

test('un administrador de país no puede cambiarle el rol a nadie', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.equal(abiertaAlPais('PATCH', `/users/${id}/role`), false);
});
