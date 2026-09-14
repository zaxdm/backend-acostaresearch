'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Revocar una licencia desde el panel avisa al comprador por correo.
 *
 * Antes solo avisaba la vigilancia automática: a quien se le revocaba a mano el
 * conector le dejaba de responder sin explicación. Se prueba que el correo
 * sale, que lleva el motivo sin dejar colar HTML, que revocar dos veces no
 * manda dos correos y que un SMTP caído no hace fallar la revocación.
 *
 * La base, el repositorio y el correo se sustituyen; la plantilla es la real.
 */

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { licencia: null, usuario: null, correos: [], smtpCaido: false };

sustituir('../src/lib/prisma', {
  user: { findUnique: async () => estado.usuario },
});
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });
sustituir('../src/lib/mailer', {
  sendMail: async (correo) => {
    if (estado.smtpCaido) throw new Error('SMTP caído');
    estado.correos.push(correo);
  },
});
sustituir('../src/modules/licensing/license.repository', {
  findById: async () => estado.licencia && { ...estado.licencia },
  setStatus: async (_id, { status, revokedReason }) =>
    Object.assign(estado.licencia, { status, revokedReason, revokedAt: new Date() }),
});

const licenseService = require('../src/modules/licensing/license.service');
const plantillas = require('../src/lib/emailTemplates');

function empezar({ status = 'ACTIVE', email = 'tesista@unitru.edu.pe' } = {}) {
  estado.licencia = { id: 'L1', userId: 'U1', status };
  estado.usuario = email ? { email, firstName: 'Ana' } : null;
  estado.correos = [];
  estado.smtpCaido = false;
}

/** El correo sale sin await: se deja correr la cola antes de mirar. */
const esperarCorreo = () => new Promise((r) => setTimeout(r, 10));

test('al revocar desde el panel le llega un correo al comprador con el motivo', async () => {
  empezar();

  await licenseService.revoke('L1', 'Uso compartido');
  await esperarCorreo();

  assert.equal(estado.licencia.status, 'REVOKED');
  assert.equal(estado.correos.length, 1);
  const [correo] = estado.correos;
  assert.equal(correo.to, 'tesista@unitru.edu.pe');
  assert.match(correo.subject, /desactivada/i);
  assert.match(correo.text, /Motivo: Uso compartido/);
  assert.match(correo.html, /Uso compartido/);
  assert.match(correo.text, /Hola Ana:/);
});

test('revocar una licencia ya revocada no manda un segundo correo', async () => {
  empezar({ status: 'REVOKED' });

  await licenseService.revoke('L1', 'Motivo corregido');
  await esperarCorreo();

  assert.equal(estado.licencia.revokedReason, 'Motivo corregido');
  assert.equal(estado.correos.length, 0);
});

test('si el correo falla, la licencia queda revocada igual', async () => {
  empezar();
  estado.smtpCaido = true;

  const actualizada = await licenseService.revoke('L1', 'Uso compartido');
  await esperarCorreo();

  assert.equal(actualizada.status, 'REVOKED');
});

test('sin correo del titular no se intenta enviar nada', async () => {
  empezar({ email: null });

  await licenseService.revoke('L1');
  await esperarCorreo();

  assert.equal(estado.correos.length, 0);
});

test('el motivo va escapado: lo que escribe el panel no llega como HTML', () => {
  const mail = plantillas.licenseRevoked({
    firstName: 'Ana',
    reason: '<a href="https://malo.example">clic</a>',
  });

  assert.ok(!mail.html.includes('<a href="https://malo.example">'));
  assert.ok(mail.html.includes('&lt;a href='));
});

test('sin motivo el correo no deja un «Motivo:» vacío', () => {
  const mail = plantillas.licenseRevoked({ firstName: 'Ana', reason: '   ' });

  assert.ok(!/Motivo/.test(mail.text));
  assert.ok(!/Motivo/.test(mail.html));
});

test('sin nombre el saludo no queda cojo', () => {
  const mail = plantillas.licenseRevoked({ firstName: null, reason: 'Uso compartido' });

  assert.match(mail.text, /^Hola:/);
  assert.match(mail.html, /Hola: hemos/);
});
