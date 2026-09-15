'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const plantillas = require('../src/lib/emailTemplates');

/**
 * Ningún dato de fuera entra en un correo como HTML.
 *
 * El nombre lo escribe quien se registra, y el correo con el código va a la
 * dirección que él pone: con un enlace por nombre, cualquiera mandaba a otra
 * persona un correo de phishing con nuestro dominio y nuestra firma. Lo mismo
 * con el número de operación de un Yape, que llega al administrador.
 *
 * Se prueban todos los correos con TODOS los campos de texto envenenados: el
 * que se añada mañana tiene que entrar en esta lista.
 */

const MALO = '<a href="https://phish.example">Verifica aquí</a>';

const CASOS = [
  ['emailVerificationCode', { firstName: MALO, code: '123456', expiresInMinutes: 15 }],
  ['passwordChangeCode', { firstName: MALO, code: '123456', expiresInMinutes: 15 }],
  ['adminAccountCreated', { firstName: MALO, email: MALO, password: MALO }],
  ['licenseAlert', { firstName: MALO, motivos: [MALO], revocada: false }],
  ['licenseAlert', { firstName: MALO, motivos: [MALO], revocada: true }],
  ['licenseRevoked', { firstName: MALO, reason: MALO }],
  [
    'manualPaymentReceived',
    {
      buyer: { firstName: MALO, lastName: MALO, email: MALO },
      planName: MALO,
      amountCents: 19900,
      operationCode: MALO,
      paymentId: MALO,
    },
  ],
  ['licenseReady', { firstName: MALO, planName: MALO, connectorUrl: MALO, expiresAt: null, via: 'yape' }],
  ['licenseRenewed', { firstName: MALO, planName: MALO, expiresAt: null, via: 'yape' }],
  ['licenseProductChanged', { firstName: MALO, planName: MALO, capitulos: 9 }],
  ['licenseExpiring', { firstName: MALO, planName: MALO, expiresAt: null, dias: 3 }],
  ['wordsReady', { firstName: MALO, planName: MALO, words: 1000, expiresAt: null, via: 'online' }],
  ['manualPaymentRejected', { firstName: MALO, planName: MALO, motivo: MALO }],
  ['activationCode', { codes: [MALO], planName: MALO, expiresAt: null }],
];

for (const [nombre, datos] of CASOS) {
  test(`${nombre}: lo escrito por otro llega como texto, no como enlace`, () => {
    const { html } = plantillas[nombre](datos);
    assert.ok(!html.includes('href="https://phish'), 'el enlace inyectado llegó vivo al HTML');
    assert.ok(html.includes('&lt;a href=&quot;https://phish'), 'el texto debería verse, escapado');
  });
}

test('un nombre normal, con tildes, se ve tal cual', () => {
  const { html } = plantillas.emailVerificationCode({
    firstName: 'María José',
    code: '123456',
    expiresInMinutes: 15,
  });
  assert.ok(html.includes('Hola María José, este es tu código'));
});
