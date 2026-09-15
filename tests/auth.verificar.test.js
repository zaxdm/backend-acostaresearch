'use strict';

/**
 * Confirmar el correo: lo que tiene que comprobar además del código.
 *
 * Dos casos reales:
 *
 *   · Repetir el formulario cuando la cuenta ya existía respondía con el usuario
 *     entero —nombre, rol, estado— sin comprobar ningún código. Con saber el
 *     correo de alguien bastaba para saber quién es y si es administrador.
 *   · Registrarse otra vez con un correo sin confirmar sobrescribe la
 *     contraseña. Quien registraba el correo de otro justo detrás de él se
 *     quedaba la cuenta: la víctima tecleaba el código que le llegaba y la
 *     cuenta nacía con la contraseña ajena. Por eso se pide la del registro.
 *
 * La base, el correo y Google se sustituyen. Argon2 va de verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const estado = { pendiente: null, usuario: null, fallos: 0, creados: [] };

sustituir('../src/config/env', {
  EMAIL_VERIFICATION_TTL_MINUTES: 15,
  JWT_REFRESH_TTL_DAYS: 30,
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_ACCESS_TTL: '15m',
});
sustituir('../src/config/logger', { info() {}, warn() {}, error() {} });
sustituir('../src/modules/users/user.repository', {
  findByEmail: async () => estado.usuario,
  publicSelect: {},
});
sustituir('../src/modules/auth/token.repository', {});
sustituir('../src/modules/auth/pendingRegistration.repository', {
  findByEmail: async () => estado.pendiente,
  registerFailedAttempt: async () => ({ attempts: ++estado.fallos }),
  promoteToUser: async (id, datos) => {
    estado.creados.push(datos);
    return { id: 'u-nuevo', email: datos.email };
  },
});
sustituir('../src/modules/auth/google.verifier', {});
sustituir('../src/modules/billing/billing.service', { grantTrial: async () => {} });
sustituir('../src/lib/mailer', { sendMail: async () => {} });

const authService = require('../src/modules/auth/auth.service');
const { hashPassword } = require('../src/shared/utils/password');
const { hashToken } = require('../src/shared/utils/tokens');

const CORREO = 'rosa@gmail.com';
const CODIGO = '482913';

async function altaPendiente(contrasena) {
  return {
    id: 'p1',
    email: CORREO,
    firstName: 'Rosa',
    lastName: 'Tecocha',
    passwordHash: await hashPassword(contrasena),
    codeHash: hashToken(CODIGO),
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  };
}

test.beforeEach(() => {
  estado.pendiente = null;
  estado.usuario = null;
  estado.fallos = 0;
  estado.creados = [];
});

test('con la cuenta ya creada, verificar de nuevo sale bien pero no devuelve sus datos', async () => {
  estado.usuario = { id: 'u1', firstName: 'Rosa', lastName: 'Tecocha', role: 'ADMIN', status: 'ACTIVE' };
  const r = await authService.verifyEmail({ email: CORREO, code: '000000', password: 'x' });
  assert.equal(r, null);
});

test('sin alta pendiente ni cuenta, el código no vale', async () => {
  await assert.rejects(
    authService.verifyEmail({ email: 'nadie@gmail.com', code: '000000', password: 'x' }),
    /no es válido/,
  );
});

test('el código bueno con la contraseña de otro no crea la cuenta, y cuenta como intento', async () => {
  // Lo que queda guardado es la contraseña del que registró el correo detrás.
  estado.pendiente = await altaPendiente('ContrasenaDelOtro1');

  await assert.rejects(
    authService.verifyEmail({ email: CORREO, code: CODIGO, password: 'ContrasenaDeRosa1' }),
    (error) => error.code === 'REGISTRATION_PASSWORD_MISMATCH',
  );
  assert.equal(estado.creados.length, 0);
  assert.equal(estado.fallos, 1);
});

test('sin contraseña tampoco nace la cuenta', async () => {
  estado.pendiente = await altaPendiente('ContrasenaDeRosa1');
  await assert.rejects(authService.verifyEmail({ email: CORREO, code: CODIGO }));
  assert.equal(estado.creados.length, 0);
});

test('el código bueno con la contraseña del registro crea la cuenta', async () => {
  estado.pendiente = await altaPendiente('ContrasenaDeRosa1');
  const user = await authService.verifyEmail({ email: CORREO, code: CODIGO, password: 'ContrasenaDeRosa1' });
  assert.equal(user.id, 'u-nuevo');
  assert.equal(estado.creados.length, 1);
  assert.equal(estado.creados[0].passwordHash, estado.pendiente.passwordHash);
});
