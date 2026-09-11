'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { esApoyo } = require('../src/modules/projects/project.service');

/**
 * El panel separa las fases del método de las herramientas de apoyo. Si una
 * fase se tomara por herramienta, desaparecería del avance; si una herramienta
 * se tomara por fase, volvería a salir como «lo siguiente» antes de la fase 0.
 */

test('las fases de la tesis, numeradas, son fases', () => {
  assert.equal(esApoyo('1 · Tema y delimitación'), false);
  assert.equal(esApoyo('7 · Capítulo IV · Resultados'), false);
});

test('las fases del artículo, con «Fase», son fases', () => {
  assert.equal(esApoyo('Fase 0 — Tema y orientación'), false);
  assert.equal(esApoyo('Fase 3B — Mapeo bibliométrico'), false);
  assert.equal(esApoyo('fase 9 — Respuesta a revisores'), false);
});

test('lo que no lleva número es herramienta de apoyo', () => {
  assert.equal(esApoyo('Humanizador académico'), true);
  assert.equal(esApoyo('Bajar similitud'), true);
});

test('una palabra que empieza por «fase» no cuenta como fase', () => {
  assert.equal(esApoyo('Fases de revisión'), true);
});
