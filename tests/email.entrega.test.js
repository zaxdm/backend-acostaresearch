'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const plantillas = require('../src/lib/emailTemplates');

/**
 * Los correos de entrega son el único sitio donde la URL del conector vuelve a
 * existir después de emitirse: del token solo se guarda su SHA-256. Por eso lo
 * que se prueba aquí no es la maquetación, sino las dos cosas que, si se
 * rompen, dejan a un comprador sin acceso o le hacen reinstalar sin motivo:
 *
 *   1. Que el correo de una licencia nueva LLEVE la URL, entera y sin cortar.
 *   2. Que el de una renovación NO lleve ninguna.
 */

const URL_CONECTOR = 'https://api.acostaresearch.com/mcp/QujLi8QdMQ7wyB0q8d1r_LW3tXTh_9Ju';
const PLAN = 'Método de tesis · 9 capítulos';
const VENCE = new Date('2026-12-04T05:00:00Z'); // 4 de diciembre a medianoche en Lima

test('el correo de una licencia nueva lleva la URL en el texto y en el HTML', () => {
  const mail = plantillas.licenseReady({
    firstName: 'María',
    planName: PLAN,
    connectorUrl: URL_CONECTOR,
    expiresAt: VENCE,
    via: 'online',
  });

  assert.ok(mail.text.includes(URL_CONECTOR), 'la versión de texto plano no trae la URL');
  assert.ok(mail.html.includes(URL_CONECTOR), 'la versión HTML no trae la URL');

  // Quien lea esto en un mes tiene que poder buscarla por el asunto.
  assert.match(mail.subject, /acceso/i);
});

test('avisa de que la URL no se puede reenviar', () => {
  const mail = plantillas.licenseReady({
    firstName: 'María',
    planName: PLAN,
    connectorUrl: URL_CONECTOR,
    expiresAt: VENCE,
    via: 'yape',
  });

  // Sin este aviso, quien borre el correo se queda sin salida y no lo sabe.
  assert.match(mail.text, /no podemos volver a enviártela/i);
  assert.match(mail.html, /Guárdala/);
});

test('una renovación no menciona ninguna URL', () => {
  const mail = plantillas.licenseRenewed({
    firstName: 'María',
    planName: PLAN,
    expiresAt: VENCE,
    via: 'yape',
  });

  // El token no cambia al renovar. Enseñarle una dirección aquí —aunque fuera
  // la suya— le haría creer que la que tiene instalada dejó de servir.
  assert.ok(!/\/mcp\//.test(mail.text), 'el texto insinúa una URL del conector');
  assert.ok(!/\/mcp\//.test(mail.html), 'el HTML insinúa una URL del conector');
  assert.match(mail.text, /No tienes que tocar nada en Claude/i);
});

test('la primera frase cambia según de dónde viene la compra', () => {
  const comun = { firstName: 'María', planName: PLAN, connectorUrl: URL_CONECTOR, expiresAt: VENCE };

  // Un Yape se aprueba horas después: la frase responde a esa espera.
  assert.match(plantillas.licenseReady({ ...comun, via: 'yape' }).text, /Hemos comprobado tu pago/);
  assert.match(plantillas.licenseReady({ ...comun, via: 'online' }).text, /Hemos confirmado tu pago/);
  assert.match(plantillas.licenseReady({ ...comun, via: 'codigo' }).text, /Hemos activado tu código/);
});

test('la caducidad se cuenta en hora de Lima, no en la del servidor', () => {
  const mail = plantillas.licenseReady({
    firstName: 'María',
    planName: PLAN,
    connectorUrl: URL_CONECTOR,
    expiresAt: VENCE,
    via: 'online',
  });

  // Un VPS en UTC formatearía esta misma fecha como el 4; el comprador está en
  // Perú y su licencia vence el 4 allí. Sin fijar la zona, el correo y el panel
  // se contradicen por un día.
  assert.match(mail.text, /4 de diciembre de 2026/);
});

test('una licencia sin caducidad no inventa una fecha', () => {
  const mail = plantillas.licenseReady({
    firstName: 'María',
    planName: PLAN,
    connectorUrl: URL_CONECTOR,
    expiresAt: null,
    via: 'online',
  });

  assert.match(mail.text, /No caduca/);
  assert.ok(!mail.text.includes('Invalid'), 'se coló una fecha inválida');
});

test('la bolsa de palabras se anuncia con la cantidad y su caducidad', () => {
  const mail = plantillas.wordsReady({
    firstName: 'Luis',
    planName: 'Tesista',
    words: 30000,
    expiresAt: VENCE,
    via: 'yape',
  });

  assert.match(mail.text, /30[.,]000 palabras/);
  assert.match(mail.text, /4 de diciembre de 2026/);
});
