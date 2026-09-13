'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { queBorrar } = require('../scripts/reparar-fuentes');

/**
 * La decisión del script que limpia duplicados ya guardados: de varias fuentes
 * con el mismo DOI, cuáles se borran. Lo único que no puede pasar es borrar una
 * citada, porque su clave está escrita en un capítulo.
 */

const fuente = (ref, origin, createdAt) => ({ ref, origin, createdAt: new Date(createdAt) });

test('una fuente sola no se toca', () => {
  assert.deepEqual(queBorrar([fuente('AR1', 'SCOPUS', '2026-01-01')], new Set()), []);
});

test('si una está citada, se queda esa aunque sea la más nueva', () => {
  const vieja = fuente('AR1', 'ZOTERO', '2026-01-01');
  const citada = fuente('AR2', 'SCOPUS', '2026-09-01');
  assert.deepEqual(queBorrar([vieja, citada], new Set(['AR2'])), [vieja]);
});

test('dos citadas se quedan las dos: no se borra nunca una citada', () => {
  const a = fuente('AR1', 'ZOTERO', '2026-01-01');
  const b = fuente('AR2', 'SCOPUS', '2026-02-01');
  const c = fuente('AR3', 'SCOPUS', '2026-03-01');
  assert.deepEqual(queBorrar([a, b, c], new Set(['AR1', 'AR2'])), [c]);
});

test('sin citas, se queda la de Zotero antes que la más antigua', () => {
  const subida = fuente('AR1', 'SCOPUS', '2026-01-01');
  const deZotero = fuente('AR2', 'ZOTERO', '2026-09-01');
  assert.deepEqual(queBorrar([subida, deZotero], new Set()), [subida]);
});

test('sin citas ni Zotero, se queda la más antigua', () => {
  const nueva = fuente('AR2', 'SCOPUS', '2026-09-01');
  const vieja = fuente('AR1', 'SCOPUS', '2026-01-01');
  assert.deepEqual(queBorrar([nueva, vieja], new Set()), [nueva]);
});
