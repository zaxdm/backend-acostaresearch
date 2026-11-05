'use strict';

/**
 * El Taller Investigador PRO (códigos TALLER*): un producto aparte que acaba en
 * un artículo. Sin su perfil, el servidor lo trataba como tesis (portada y
 * páginas de tesis, biblioteca de formatos, «tu tesis»).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  perfilDe,
  esTesisDelMetodo,
  verificaCitas,
  traeHerramientas,
  ARTICULO,
  TESIS,
} = require('../src/modules/productos/producto.perfil');

test('lo que empieza por TALLER es el taller, con el tipo de un artículo', () => {
  const taller = perfilDe('TALLER_INVESTIGADOR');
  assert.notEqual(taller, TESIS);
  assert.equal(taller.tipo, 'articulo');
  assert.equal(taller.modalidad, 'taller');
  assert.equal(taller.ruta, 'Taller Investigador PRO');
  assert.equal(taller.archivo, 'taller-investigador');
  assert.equal(taller.tuObra, 'tu artículo');
  assert.equal(taller.revision, 'revisar_el_articulo');
  assert.ok(Object.isFrozen(taller));
});

test('no es tesis del método, verifica citas (4-nov) y trae las herramientas', () => {
  assert.equal(esTesisDelMetodo('TALLER_INVESTIGADOR'), false);
  assert.equal(verificaCitas('TALLER_INVESTIGADOR'), true);
  assert.equal(traeHerramientas('TALLER_INVESTIGADOR'), true);
});

test('el artículo empírico sigue igual y sin modalidad', () => {
  assert.equal(ARTICULO.modalidad, undefined);
  assert.equal(ARTICULO.ruta, undefined);
  assert.equal(perfilDe('ARTICULO_SCIENTIFICOS'), ARTICULO);
  assert.equal(verificaCitas('ARTICULO_SCIENTIFICOS'), true);
});
