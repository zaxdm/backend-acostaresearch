'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nombreApa } = require('../src/modules/references/openalex.client');
const { unir } = require('../src/modules/references/crossref.client');

/**
 * Los autores que acaban en la bibliografía del Word.
 *
 * El 13 de septiembre de 2026 la bola de nieve y la búsqueda abierta enseñaban
 * «F. Larcker, D.», «M. Podsakoff, P.» o «Sugey Román-Córdova, V.»: se tomaba la
 * primera palabra como nombre y el resto como apellido. Se prueba con esos
 * mismos nombres, y con los que el arreglo no puede romper.
 */

test('una inicial es del nombre, no del apellido', () => {
  assert.equal(nombreApa('David F. Larcker'), 'Larcker, D.');
  assert.equal(nombreApa('Philip M. Podsakoff', ['US']), 'Podsakoff, P.');
  assert.equal(nombreApa('Christian M Ringle'), 'Ringle, C.');
  assert.equal(nombreApa('Jean J.-P. Martin', ['FR']), 'Martin, J.');
});

test('un apellido con guion va solo, aunque haya dos nombres delante', () => {
  assert.equal(nombreApa('Vanessa Sugey Román-Córdova', ['PE']), 'Román-Córdova, V.');
  assert.equal(nombreApa('Oscar Malpartida-Maíz'), 'Malpartida-Maíz, O.');
});

test('en países de dos apellidos, con cuatro palabras los apellidos son los dos últimos', () => {
  assert.equal(nombreApa('Rafael Domingo Chavez Vilcahuaman', ['PE']), 'Chavez Vilcahuaman, R.');
  assert.equal(nombreApa('Rosa Isabel Tecocha Portocarrero'), 'Tecocha Portocarrero, R.');
});

test('con tres palabras se mantiene lo de siempre: nombre y dos apellidos', () => {
  assert.equal(nombreApa('Christian Díaz Peralta', ['PE']), 'Díaz Peralta, C.');
  assert.equal(nombreApa('Christian Díaz Peralta'), 'Díaz Peralta, C.');
});

test('si se sabe que no es de un país de dos apellidos, el apellido es la última palabra', () => {
  assert.equal(nombreApa('Jin Yeon Lee', ['KR']), 'Lee, J.');
  assert.equal(nombreApa('Nisreen Mohammed Ameen', ['GB']), 'Ameen, N.');
});

test('las partículas van con el apellido', () => {
  assert.equal(nombreApa('Juan de la Cruz'), 'de la Cruz, J.');
  assert.equal(nombreApa('Ludwig van Beethoven', ['DE']), 'van Beethoven, L.');
});

test('un nombre de una palabra, o ninguno, no se inventa', () => {
  assert.equal(nombreApa('Aristóteles'), 'Aristóteles');
  assert.equal(nombreApa(''), null);
  assert.equal(nombreApa(undefined), null);
});

// ── Crossref por encima de OpenAlex, solo en los autores y solo si se pide ──

const deOpenAlex = {
  doi: '10.1177/002224378101800104',
  title: 'Evaluating Structural Equation Models',
  authors: 'Fornell, C.; F. Larcker, D.',
  source: 'Journal of Marketing Research',
  volume: null,
  pages: null,
  abstract: 'Resumen de OpenAlex',
};

const deCrossref = {
  authors: 'Fornell, C.; Larcker, D.',
  source: 'J. Mark. Res.',
  volume: '18',
  issue: '1',
  pages: '39-50',
  abstract: null,
};

test('al guardar por DOI, los autores de Crossref ganan a los de OpenAlex', () => {
  const ficha = unir(deOpenAlex, deCrossref, { preferirSusAutores: true });
  assert.equal(ficha.authors, 'Fornell, C.; Larcker, D.');
  // El resto sigue siendo rellenar huecos: la revista buena no se pisa.
  assert.equal(ficha.source, 'Journal of Marketing Research');
  assert.equal(ficha.volume, '18');
  assert.equal(ficha.pages, '39-50');
  assert.equal(ficha.abstract, 'Resumen de OpenAlex');
});

test('sin pedirlo, los autores que ya venían no se tocan (Zotero, exports)', () => {
  assert.equal(unir(deOpenAlex, deCrossref).authors, 'Fornell, C.; F. Larcker, D.');
});

test('si Crossref no tiene autores o no conoce el DOI, se quedan los que había', () => {
  assert.equal(
    unir(deOpenAlex, { ...deCrossref, authors: '' }, { preferirSusAutores: true }).authors,
    'Fornell, C.; F. Larcker, D.',
  );
  assert.equal(unir(deOpenAlex, null, { preferirSusAutores: true }), deOpenAlex);
});
