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

const { guiaBodySchema, guiaPatchSchema } = require('../src/modules/guias/guia.schema');

test('el grupo de una guía es de instalación o de herramientas, y por defecto de instalación', () => {
  const base = { titulo: 'Guía de Zotero' };
  assert.equal(guiaBodySchema.parse(base).grupo, 'instalacion');
  assert.equal(guiaBodySchema.parse({ ...base, grupo: 'herramientas' }).grupo, 'herramientas');
  assert.equal(guiaBodySchema.safeParse({ ...base, grupo: 'Herramientas ' }).success, false);
  assert.equal(guiaBodySchema.safeParse({ ...base, grupo: 'otra' }).success, false);
  // Al editar sin tocar el grupo, no se cambia: el parcial no pone el de por defecto.
  assert.equal(guiaPatchSchema.parse({ titulo: 'Otra' }).grupo, undefined);
});
