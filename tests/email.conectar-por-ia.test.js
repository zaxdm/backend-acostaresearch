'use strict';

/**
 * «¿Qué IA usas?» en los correos (28-oct): el del código y el de acceso activo
 * llevan un botón por IA a /conectar/<ia> y la nota de que Gemini no sirve.
 * Clientes de ChatGPT preguntaban por WhatsApp porque solo se explicaba Claude.
 * El correo sin conector (Edición y Traducción) no lo lleva.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const plantillas = require('../src/lib/emailTemplates');

const RUTAS = ['/conectar/claude', '/conectar/chatgpt', '/conectar/grok'];

const llevaLasTres = (texto) => RUTAS.every((r) => texto.includes(r));

test('el correo del código lleva un enlace por IA, en HTML y en texto, y la nota de Gemini', () => {
  for (const tieneCuenta of [false, true]) {
    const mail = plantillas.activationCode({ codes: ['ABCD-1234'], planName: 'Método de tesis', tieneCuenta });
    assert.ok(llevaLasTres(mail.html), 'HTML');
    assert.ok(llevaLasTres(mail.text), 'texto');
    assert.match(mail.html, /Uso ChatGPT/);
    assert.match(mail.text, /Gemini todavía no permite conectores/);
  }
});

test('sin conector (Edición y Traducción) no hay botones por IA', () => {
  const mail = plantillas.activationCode({ codes: ['ABCD-1234'], planName: 'Edición', conector: false });
  assert.equal(RUTAS.some((r) => mail.html.includes(r) || mail.text.includes(r)), false);
});

test('el correo de acceso activo también los lleva', () => {
  const mail = plantillas.licenseReady({ firstName: 'Ana', planName: 'Método de tesis', via: 'online' });
  assert.ok(llevaLasTres(mail.html));
  assert.ok(llevaLasTres(mail.text));
});
