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

test('el correo de una licencia nueva NO lleva la URL y dice dónde sacarla (28-oct)', () => {
  const mail = plantillas.licenseReady({
    firstName: 'María',
    planName: PLAN,
    connectorUrl: URL_CONECTOR,
    expiresAt: VENCE,
    via: 'online',
  });

  for (const cuerpo of [mail.text, mail.html]) {
    assert.ok(!cuerpo.includes(URL_CONECTOR), 'el correo trae la URL del conector');
    assert.ok(!/\/mcp\//.test(cuerpo), 'el correo insinúa una URL del conector');
    assert.match(cuerpo, /Obtener mi URL/);
  }

  // Quien lea esto en un mes tiene que poder buscarla por el asunto.
  assert.match(mail.subject, /acceso/i);
});

test('el correo del acceso lleva el video de inicio, además de la página de videos', () => {
  const mail = plantillas.licenseReady({
    firstName: 'María',
    planName: PLAN,
    connectorUrl: URL_CONECTOR,
    expiresAt: VENCE,
    via: 'online',
  });

  for (const cuerpo of [mail.text, mail.html]) {
    assert.ok(cuerpo.includes('https://youtu.be/7L3FihV7seI'), 'falta el video de inicio');
    assert.ok(cuerpo.includes('/perfil/ayuda'), 'falta el enlace a todos los videos');
    // El «?si=» de YouTube es su seguimiento de quién compartió: no va en el correo.
    assert.ok(!cuerpo.includes('si='), 'el enlace del video lleva el seguimiento de YouTube');
  }
});

test('el correo del código trae solo el código, sin botón, y cambia si ya tiene cuenta (28-oct)', () => {
  const sin = plantillas.activationCode({ codes: ['ACR-AAAA-BBBB-CCCC'], planName: PLAN, expiresAt: null });
  const con = plantillas.activationCode({
    codes: ['ACR-AAAA-BBBB-CCCC'],
    planName: PLAN,
    expiresAt: null,
    tieneCuenta: true,
  });

  for (const mail of [sin, con]) {
    // Sin botón ni enlace que active solo: el código se pega a mano en /planes.
    assert.ok(!mail.html.includes('Activar mi acceso'), 'sigue el botón «Activar mi acceso»');
    assert.ok(!/auth\/activar/.test(mail.html + mail.text), 'sigue el enlace a /auth/activar');
    assert.ok(!/planes\?codigo=/.test(mail.html + mail.text), 'el enlace a precios lleva el código puesto');
    assert.ok(mail.html.includes('ACR-AAAA-BBBB-CCCC'));
    assert.match(mail.html, /Pagaste por Yape o transferencia/);
    assert.match(mail.html, /Canjear/);
    // Ninguno promete la URL por correo.
    assert.ok(!/te llega también por correo/.test(mail.text));
    // Sin configurar, el video de siempre; nunca uno vacío.
    assert.ok(mail.html.includes('https://youtu.be/7L3FihV7seI'));
  }

  assert.match(sin.text, /Crea tu cuenta/);
  assert.match(con.text, /Entra con tu cuenta/);
  assert.ok(!con.text.includes('Crea tu cuenta'), 'a quien tiene cuenta le pide crearla');
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

test('todos los correos llevan en el pie los Términos y la Política de Privacidad', () => {
  const correos = [
    plantillas.emailVerificationCode({ firstName: 'Ana', code: '123456', expiresInMinutes: 10 }),
    plantillas.licenseReady({ firstName: 'Ana', planName: PLAN, connectorUrl: URL_CONECTOR, expiresAt: VENCE }),
    plantillas.activationCode({ codes: ['ABCD-EFGH-IJKL'], planName: PLAN, expiresAt: VENCE }),
  ];

  for (const mail of correos) {
    assert.match(mail.html, /href="[^"]*\/terminos"[^>]*>Términos y Condiciones</);
    assert.match(mail.html, /href="[^"]*\/privacidad"[^>]*>Política de Privacidad</);
  }
});
