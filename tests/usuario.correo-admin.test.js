'use strict';

/**
 * El administrador cambia el correo de una cuenta.
 *
 * Lo que se prueba: que cambia el correo y desvincula Google, que no pisa el de
 * otra cuenta, que el mismo correo no toca nada, y que avisa a los dos correos.
 * La base y el correo se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const estado = { usuario: null, ocupado: null, actualizado: null, borrados: null, enviados: [] };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/users/user.repository', {
  publicSelect: {},
  findById: async () => estado.usuario,
  findByEmail: async () => estado.ocupado,
});
sustituir('../src/lib/prisma', {
  user: { update: (args) => ((estado.actualizado = args), args) },
  pendingRegistration: { deleteMany: (args) => ((estado.borrados = args), args) },
  $transaction: async (operaciones) => operaciones,
});
sustituir('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    estado.enviados.push(mensaje);
  },
});
sustituir('../src/lib/notify', { avisarAlAdmin: () => {} });

const userService = require('../src/modules/users/user.service');

function empezar() {
  estado.usuario = {
    id: 'u1',
    email: 'viejo@gmail.com',
    firstName: 'Tesista',
    emailVerifiedAt: new Date('2026-09-01'),
  };
  estado.ocupado = null;
  estado.actualizado = null;
  estado.borrados = null;
  estado.enviados = [];
}

const cambiar = (email) => userService.cambiarCorreoPorAdmin({ userId: 'u1', email, adminId: 'a1' });

test('cambia el correo, desvincula Google y avisa a los dos correos', async () => {
  empezar();

  assert.deepEqual(await cambiar('nuevo@gmail.com'), {
    anterior: 'viejo@gmail.com',
    email: 'nuevo@gmail.com',
  });
  assert.equal(estado.actualizado.data.email, 'nuevo@gmail.com');
  assert.equal(estado.actualizado.data.googleId, null, 'Google se desvincula');
  assert.deepEqual(estado.borrados.where, { email: 'nuevo@gmail.com' });

  await new Promise((listo) => setImmediate(listo));
  assert.deepEqual(
    estado.enviados.map((m) => m.to),
    ['nuevo@gmail.com', 'viejo@gmail.com'],
  );
  assert.match(estado.enviados[0].text, /entras a Acosta Research con nuevo@gmail\.com/);
  assert.match(estado.enviados[1].text, /Si no lo pediste tú/);
});

test('no pisa el correo de otra cuenta', async () => {
  empezar();
  estado.ocupado = { id: 'u2', email: 'nuevo@gmail.com' };

  await assert.rejects(cambiar('nuevo@gmail.com'), /otra cuenta/);
  assert.equal(estado.actualizado, null);
  assert.deepEqual(estado.enviados, []);
});

test('el mismo correo no cambia nada ni manda avisos', async () => {
  empezar();

  assert.deepEqual(await cambiar('viejo@gmail.com'), {
    anterior: 'viejo@gmail.com',
    email: 'viejo@gmail.com',
  });
  assert.equal(estado.actualizado, null);
  assert.deepEqual(estado.enviados, []);
});

test('sin cuenta detrás de la licencia, lo dice', async () => {
  empezar();
  estado.usuario = null;

  await assert.rejects(cambiar('nuevo@gmail.com'), /No encontramos la cuenta/);
});
