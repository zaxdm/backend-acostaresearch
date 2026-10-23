'use strict';

/**
 * «Olvidé mi contraseña»: lo que tiene que cumplir además de mandar un código.
 *
 *   · Responde igual exista o no el correo, y no manda nada a una cuenta
 *     suspendida o sin confirmar.
 *   · Un código erróneo gasta un intento y no cambia nada.
 *   · Un código bueno cambia la contraseña, gasta el código y cierra todas las
 *     sesiones.
 *
 * La base, el correo y Google se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const estado = { usuario: null, codigo: null, correos: [], cambios: [], borrados: 0, revocadas: [] };

sustituir('../src/config/env', {
  EMAIL_VERIFICATION_TTL_MINUTES: 15,
  JWT_REFRESH_TTL_DAYS: 30,
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_ACCESS_TTL: '15m',
});
sustituir('../src/config/logger', { info() {}, warn() {}, error() {} });
sustituir('../src/modules/users/user.repository', {
  findByEmail: async () => estado.usuario,
  findPorReclamar: async () => null,
  publicSelect: {},
});
sustituir('../src/modules/auth/token.repository', {
  revokeAllForUser: async (id) => {
    estado.revocadas.push(id);
    return { count: 2 };
  },
});
sustituir('../src/modules/auth/pendingRegistration.repository', {});
sustituir('../src/modules/auth/google.verifier', {});
sustituir('../src/modules/billing/billing.service', {});
sustituir('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    estado.correos.push(mensaje);
  },
});
sustituir('../src/lib/prisma', {
  accountCode: {
    upsert: async ({ create, update }) => {
      estado.codigo = { id: 'c1', ...(estado.codigo ? update : create) };
      return estado.codigo;
    },
    findUnique: async () => estado.codigo,
    update: async () => {
      estado.codigo.attempts += 1;
      return estado.codigo;
    },
    delete: async () => {
      estado.borrados += 1;
      return {};
    },
  },
  user: {
    update: async ({ data }) => {
      estado.cambios.push(data);
      return {};
    },
  },
  $transaction: async (operaciones) => Promise.all(operaciones),
});

const authService = require('../src/modules/auth/auth.service');
const { hashToken } = require('../src/shared/utils/tokens');

const CORREO = 'rosa@gmail.com';
const NUEVA = 'ClaveNueva2026';

function usuario(extra = {}) {
  return {
    id: 'u1',
    email: CORREO,
    firstName: 'Rosa',
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
    ...extra,
  };
}

function codigoGuardado(codigo, extra = {}) {
  return {
    id: 'c1',
    codeHash: hashToken(codigo),
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  };
}

test.beforeEach(() => {
  Object.assign(estado, {
    usuario: usuario(),
    codigo: null,
    correos: [],
    cambios: [],
    borrados: 0,
    revocadas: [],
  });
});

test('pedir el código: manda un correo con 6 dígitos a una cuenta normal', async () => {
  await authService.requestPasswordReset(CORREO);

  assert.equal(estado.correos.length, 1);
  assert.equal(estado.correos[0].to, CORREO);
  assert.match(estado.correos[0].text, /\b\d{6}\b/);
  assert.ok(estado.codigo, 'el código queda guardado');
});

test('pedir el código: correo desconocido, suspendido o sin confirmar no manda nada ni da error', async () => {
  for (const caso of [null, usuario({ status: 'SUSPENDED' }), usuario({ emailVerifiedAt: null })]) {
    estado.usuario = caso;
    await authService.requestPasswordReset(CORREO);
  }
  assert.equal(estado.correos.length, 0);
  assert.equal(estado.codigo, null);
});

test('restablecer: código bueno cambia la contraseña, gasta el código y cierra todas las sesiones', async () => {
  estado.codigo = codigoGuardado('123456');

  await authService.resetPassword({ email: CORREO, code: '123456', newPassword: NUEVA });

  assert.equal(estado.cambios.length, 1);
  assert.match(estado.cambios[0].passwordHash, /^\$argon2/);
  assert.equal(estado.borrados, 1);
  assert.deepEqual(estado.revocadas, ['u1']);
});

test('restablecer: código erróneo gasta un intento y no cambia nada', async () => {
  estado.codigo = codigoGuardado('123456');

  await assert.rejects(
    authService.resetPassword({ email: CORREO, code: '000000', newPassword: NUEVA }),
    /no es válido/,
  );

  assert.equal(estado.codigo.attempts, 1);
  assert.equal(estado.cambios.length, 0);
  assert.equal(estado.revocadas.length, 0);
});

test('restablecer: sin código pedido, caducado o agotado, no cambia nada', async () => {
  const casos = [
    null,
    codigoGuardado('123456', { expiresAt: new Date(Date.now() - 1000) }),
    codigoGuardado('123456', { attempts: 5 }),
  ];

  for (const guardado of casos) {
    estado.codigo = guardado;
    await assert.rejects(
      authService.resetPassword({ email: CORREO, code: '123456', newPassword: NUEVA }),
    );
  }
  assert.equal(estado.cambios.length, 0);
});

test('restablecer: una cuenta suspendida no puede, aunque el código sea bueno', async () => {
  estado.usuario = usuario({ status: 'SUSPENDED' });
  estado.codigo = codigoGuardado('123456');

  await assert.rejects(
    authService.resetPassword({ email: CORREO, code: '123456', newPassword: NUEVA }),
  );
  assert.equal(estado.cambios.length, 0);
});
