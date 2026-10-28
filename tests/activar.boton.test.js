'use strict';

/**
 * El botón «Activar mi acceso» del correo del código (26-oct).
 *
 * Lo que se prueba: que la cuenta nace con el correo del código y ya verificada,
 * que sin cuenta previa se crea, se canjea y se abre la sesión de una vez, que
 * con una cuenta ya existente no se crea otra ni se gasta el código, y que el
 * correo lleva el botón con el código detrás de «#». La base, el canje y las
 * cuentas se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { usuarios: [], canjes: [], tokens: [], borrados: [], vista: null };

sustituir('../src/lib/prisma', {
  pendingRegistration: {
    deleteMany: async ({ where }) => {
      estado.borrados.push(where.email);
      return { count: 0 };
    },
  },
});

sustituir('../src/modules/licensing/license.service', {
  vistaDelCodigo: async () => estado.vista,
  redeemCode: async ({ userId, code }) => {
    estado.canjes.push({ userId, code });
    return { license: { id: 'lic-1' }, connectorUrl: 'https://api.ejemplo/mcp/abc' };
  },
});

sustituir('../src/modules/users/user.repository', {
  findByEmail: async (email) => estado.usuarios.find((u) => u.email === email) ?? null,
  findPorReclamar: async () => null,
  create: async (data) => {
    const fila = { id: `u${estado.usuarios.length + 1}`, role: 'USER', sessionVersion: 0, ...data };
    estado.usuarios.push(fila);
    return fila;
  },
  update: async (id, data) => Object.assign(estado.usuarios.find((u) => u.id === id), data),
});

sustituir('../src/modules/auth/token.repository', {
  createRefreshToken: async (data) => estado.tokens.push(data),
});

sustituir('../src/modules/billing/billing.service', { grantTrial: async () => {} });
sustituir('../src/lib/mailer', { sendMail: async () => {} });

const authService = require('../src/modules/auth/auth.service');
const plantillas = require('../src/lib/emailTemplates');
const { activarSchema } = require('../src/modules/auth/auth.schema');

const CODIGO = 'ACR-AB12-CD34-EF56';
const DATOS = { codigo: CODIGO, firstName: 'María', lastName: 'Quispe', password: 'Clave12345' };

test.beforeEach(() => {
  estado.usuarios = [];
  estado.canjes = [];
  estado.tokens = [];
  estado.borrados = [];
  estado.vista = { email: 'maria@gmail.com', producto: 'Método de tesis', conector: true };
});

test('ver: dice si el correo del código ya tiene cuenta', async () => {
  assert.equal((await authService.verActivacion(CODIGO)).tieneCuenta, false);

  estado.usuarios.push({ id: 'u9', email: 'maria@gmail.com' });
  const vista = await authService.verActivacion(CODIGO);
  assert.equal(vista.tieneCuenta, true);
  assert.equal(vista.email, 'maria@gmail.com');
});

test('activar sin cuenta: la crea verificada con el correo del código, canjea y abre sesión', async () => {
  const r = await authService.activarConCodigo(DATOS, {});

  assert.equal(estado.usuarios.length, 1);
  const [usuario] = estado.usuarios;
  assert.equal(usuario.email, 'maria@gmail.com');
  assert.ok(usuario.emailVerifiedAt instanceof Date);
  assert.ok(usuario.passwordHash && usuario.passwordHash !== DATOS.password);

  assert.deepEqual(estado.canjes, [{ userId: usuario.id, code: CODIGO }]);
  assert.equal(r.canje.connectorUrl, 'https://api.ejemplo/mcp/abc');
  assert.ok(r.accessToken);
  assert.ok(r.refreshToken);
  assert.equal(estado.tokens.length, 1);
  assert.deepEqual(estado.borrados, ['maria@gmail.com']);
});

test('activar con una cuenta que ya existe: no crea otra ni gasta el código', async () => {
  estado.usuarios.push({ id: 'u9', email: 'maria@gmail.com' });

  await assert.rejects(() => authService.activarConCodigo(DATOS, {}), { statusCode: 409 });
  assert.equal(estado.usuarios.length, 1);
  assert.equal(estado.canjes.length, 0);
});

test('activar un código sin correo: no crea nada', async () => {
  estado.vista = { email: null, producto: 'Método de tesis', conector: true };

  await assert.rejects(() => authService.activarConCodigo(DATOS, {}), { statusCode: 400 });
  assert.equal(estado.usuarios.length, 0);
  assert.equal(estado.canjes.length, 0);
});

test('el formulario de activar no admite un correo: lo pone el servidor', () => {
  const r = activarSchema.safeParse({ ...DATOS, email: 'otro@gmail.com' });
  assert.ok(r.success);
  assert.equal('email' in r.data, false);
});

// 28-oct: el correo ya no trae el botón (pedido del dueño); se canjea pegando el
// código en /planes. La página /auth/activar sigue para los correos ya enviados.
test('el correo del código ya no lleva el botón: solo el código, a la vista y en el asunto', () => {
  const mail = plantillas.activationCode({ codes: [CODIGO], planName: 'Método de tesis', expiresAt: null });

  assert.ok(!/\/auth\/activar/.test(mail.html + mail.text), 'sigue el enlace a /auth/activar');
  assert.ok(!mail.html.includes('Activar mi acceso'), 'sigue el botón');
  assert.match(mail.html, />ACR-AB12-CD34-EF56</);
  assert.match(mail.subject, /ACR-AB12-CD34-EF56/);
});
