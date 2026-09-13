'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { revisarCorreo } = require('../src/shared/utils/correo');
const { generateCodesSchema } = require('../src/modules/licensing/license.schema');

/**
 * El 13 de septiembre se vendió un código a `kelingabrielne@gamail.com`. La
 * forma era válida, el correo salió y no le llegó a nadie. Lo que se prueba aquí
 * es que eso ya no pase, sin bloquear los dominios que sí existen.
 */

test('la errata del 13 de septiembre se detecta y se corrige', () => {
  const r = revisarCorreo('Kelingabrielne@gamail.com');

  assert.ok(r.problema);
  assert.equal(r.sugerencia, 'kelingabrielne@gmail.com');
});

test('las erratas típicas de los grandes proveedores', () => {
  const casos = {
    'ana@gmial.com': 'ana@gmail.com',
    'ana@gmal.com': 'ana@gmail.com',
    'ana@gmail.con': 'ana@gmail.com',
    'ana@gmail.co': 'ana@gmail.com',
    'ana@gmail.es': 'ana@gmail.com',
    'ana@gmail': 'ana@gmail.com',
    'ana@hotmial.com': 'ana@hotmail.com',
    'ana@hotmal.es': 'ana@hotmail.es',
    'ana@outlok.com': 'ana@outlook.com',
    'ana@yaho.com': 'ana@yahoo.com',
    'ana@icloud.con': 'ana@icloud.com',
    'anagmail.com': 'ana@gmail.com',
    'ana@miempresa.con': 'ana@miempresa.com',
  };

  for (const [escrito, esperado] of Object.entries(casos)) {
    const r = revisarCorreo(escrito);
    assert.ok(r.problema, `${escrito} debería marcarse`);
    assert.equal(r.sugerencia, esperado, escrito);
  }
});

test('los correos reales pasan sin tocar', () => {
  const buenos = [
    'jairolivaress@outlook.com',
    'mtotocayom@gmail.com',
    'yllaryvalverdel@gmail.com',
    'royhinostrozaquintana@gmail.com',
    'je.10130081@gmail.com',
    'eliasyupanqui021@gmail.com',
    'casta.rrhh@gmail.com',
    'naycha0210@gmail.com',
    'ana@hotmail.es',
    'ana@outlook.es',
    'ana@yahoo.com.pe',
    'ana@ymail.com',
    'ana@mail.com',
    'ana@live.com',
    'a20201234@unmsm.edu.pe',
    'ana@empresa.co',
  ];

  for (const correo of buenos) {
    assert.equal(revisarCorreo(correo).problema, null, correo);
  }
});

test('lo que no tiene arreglo se marca sin inventar sugerencia', () => {
  for (const correo of ['ana', 'ana@@gmail.com', '@gmail.com', 'ana@dominio', 'ana..b@x.com']) {
    const r = revisarCorreo(correo);
    assert.ok(r.problema, correo);
    assert.equal(r.sugerencia, null, correo);
  }
});

test('el servidor rechaza la errata aunque el panel se la salte', () => {
  const r = generateCodesSchema.safeParse({
    buyerEmail: 'kelingabrielne@gamail.com',
  });

  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error.issues), /kelingabrielne@gmail\.com/);
});

test('una lista de compradores válida pasa', () => {
  const r = generateCodesSchema.safeParse({
    buyerEmails: ['mtotocayom@gmail.com', 'jairolivaress@outlook.com'],
    paymentMethod: 'YAPE',
    importe: 100,
  });

  assert.equal(r.success, true);
  assert.equal(r.data.cantidad, 1);
});

test('una lista con un correo mal escrito no pasa, y dice cuál', () => {
  const r = generateCodesSchema.safeParse({
    buyerEmails: ['mtotocayom@gmail.com', 'naycha0210@gmial.com'],
  });

  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error.issues), /naycha0210@gmial\.com/);
});

test('no se aceptan a la vez un correo y una lista', () => {
  const r = generateCodesSchema.safeParse({
    buyerEmail: 'ana@gmail.com',
    buyerEmails: ['luis@gmail.com'],
  });

  assert.equal(r.success, false);
});

test('el tope de cien códigos cuenta todos los compradores', () => {
  const correos = Array.from({ length: 11 }, (_, i) => `c${i}@gmail.com`);
  const r = generateCodesSchema.safeParse({
    buyerEmails: correos,
    cantidad: 10,
  });

  assert.equal(r.success, false);
});
