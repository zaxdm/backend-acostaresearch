'use strict';

/**
 * La misma obra no sale dos veces en "buscar_fuentes" cuando está en la
 * biblioteca de la casa y en la del tesista con DOI distintos (Fornell y
 * Larcker, 1981: JSTOR y SAGE; E2E del 7-nov-2026). Se queda la suya.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sinLaMismaObraDosVeces } = require('../src/modules/references/reference.service');

const casa = { id: 'c1', ownerUserId: null, title: 'Evaluating Structural Equation Models with Unobservable Variables', year: 1981, doi: '10.2307/3151312' };
const suya = { id: 'u1', ownerUserId: 'u', title: 'Evaluating structural equation models with unobservable variables and measurement error', year: 1981, doi: '10.1177/002224378101800104' };
const igualSuya = { ...suya, title: 'Evaluating Structural Equation Models with Unobservable Variables.' };

test('si la casa y él tienen la misma obra, se queda la suya', () => {
  assert.deepEqual(sinLaMismaObraDosVeces([casa, igualSuya]).map((f) => f.id), ['u1']);
});

test('títulos distintos o años distintos no se tocan', () => {
  assert.deepEqual(sinLaMismaObraDosVeces([casa, suya]).map((f) => f.id), ['c1', 'u1'], 'el título suyo es más largo: otra obra');
  assert.deepEqual(sinLaMismaObraDosVeces([casa, { ...igualSuya, year: 1982 }]).map((f) => f.id), ['c1', 'u1']);
});

test('dos de la casa con el mismo título se quedan (no hay suya que preferir)', () => {
  assert.equal(sinLaMismaObraDosVeces([casa, { ...casa, id: 'c2' }]).length, 2);
});

test('una fuente «otro» (document) se escribe como informe, no como artículo de revista', () => {
  const { tipoCsl } = require('../src/modules/projects/project.csl');
  assert.equal(tipoCsl('document'), 'report');
  assert.equal(tipoCsl('journalArticle'), 'article-journal', 'lo demás sigue igual');
  assert.equal(tipoCsl('webpage'), 'webpage');
});
