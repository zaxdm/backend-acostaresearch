'use strict';

/**
 * El correo de caducidad es el único que llega sin que el comprador haya hecho
 * nada. Por eso importa tanto lo que dice: si asusta, o si suena a cobro, hace
 * más daño que no mandarlo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_URL = process.env.APP_URL || 'https://acostaresearch.com';

const { licenseExpiring } = require('../src/lib/emailTemplates');

const BASE = {
  firstName: 'Juan',
  planName: 'Método de tesis · 9 capítulos',
  expiresAt: new Date('2026-12-04T05:00:00.000Z'),
  dias: 15,
};

test('dice cuándo caduca, en el asunto y en el cuerpo', () => {
  const m = licenseExpiring(BASE);

  assert.match(m.subject, /dentro de 15 días/);
  assert.match(m.text, /dentro de 15 días/);
  assert.match(m.html, /dentro de 15 días/);
});

test('el último día dice «mañana» y no «dentro de 1 días»', () => {
  const m = licenseExpiring({ ...BASE, dias: 1 });

  assert.match(m.subject, /mañana/);
  assert.ok(!m.subject.includes('1 días'), 'no debe quedar el plural roto');
  assert.ok(!m.text.includes('1 días'));
});

test('promete que las fuentes del comprador no se pierden', () => {
  const m = licenseExpiring(BASE);

  // Es cierto: las fuentes cuelgan de la cuenta, no de la licencia. Y es lo
  // primero que va a temer quien lea que algo suyo «caduca».
  assert.match(m.text, /no se pierden/);
  assert.match(m.html, /no se pierden/i);
});

test('explica que la misma URL vuelve a funcionar, para que no borre el conector', () => {
  const m = licenseExpiring(BASE);

  assert.match(m.text, /la misma URL vuelve a funcionar/);
  assert.match(m.html, /misma URL vuelve a\s+funcionar/);
});

test('lleva a renovar y al panel', () => {
  const m = licenseExpiring(BASE);

  assert.match(m.text, /\/planes/);
  assert.match(m.html, /href="[^"]*\/planes"/);
  assert.match(m.html, /href="[^"]*\/perfil"/);
});

test('nombra el producto del comprador, no un genérico', () => {
  const m = licenseExpiring(BASE);

  assert.match(m.text, /Método de tesis · 9 capítulos/);
  assert.match(m.html, /Método de tesis · 9 capítulos/);
});

test('sin fecha legible no rompe el correo', () => {
  const m = licenseExpiring({ ...BASE, expiresAt: null });

  assert.match(m.subject, /dentro de 15 días/);
  assert.ok(!m.text.includes('null'));
  assert.ok(!m.html.includes('null'));
});
