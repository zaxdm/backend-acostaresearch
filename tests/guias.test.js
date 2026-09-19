'use strict';

/**
 * Las guías en PDF: que solo se guarda un PDF de verdad y que la descarga se
 * llama por su título, sin tildes ni espacios.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { comprobarPdf, nombreDeDescarga } = require('../src/modules/guias/guia.service');

test('solo se acepta un archivo que empieza como un PDF', () => {
  assert.doesNotThrow(() => comprobarPdf(Buffer.from('%PDF-1.7\n…')));
  assert.throws(() => comprobarPdf(Buffer.from('PK un docx')), /no es un PDF/);
  assert.throws(() => comprobarPdf(Buffer.alloc(0)), /Falta/);
  assert.throws(() => comprobarPdf({}), /Falta/);
});

test('la descarga se llama por el título, sin tildes ni espacios', () => {
  assert.equal(nombreDeDescarga('Guía de instalación'), 'guia-de-instalacion.pdf');
  assert.equal(nombreDeDescarga('  ¿Zotero?  '), 'zotero.pdf');
  assert.equal(nombreDeDescarga('¡¡!!'), 'guia.pdf');
});
