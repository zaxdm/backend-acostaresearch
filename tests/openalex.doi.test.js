'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { limpiarDoi } = require('../src/modules/references/openalex.client');

test('un DOI se reconoce venga como venga escrito', async (t) => {
  await t.test('a secas', () => {
    assert.equal(limpiarDoi('10.1145/3770762.3772598'), '10.1145/3770762.3772598');
  });

  await t.test('como enlace, que es como lo copia todo el mundo del PDF', () => {
    assert.equal(limpiarDoi('https://doi.org/10.1000/abc'), '10.1000/abc');
    assert.equal(limpiarDoi('http://dx.doi.org/10.1000/abc'), '10.1000/abc');
  });

  await t.test('con el prefijo «doi:», que es como lo imprimen muchas revistas', () => {
    assert.equal(limpiarDoi('doi: 10.1000/abc'), '10.1000/abc');
    assert.equal(limpiarDoi('DOI:10.1000/abc'), '10.1000/abc');
  });

  await t.test('con espacios alrededor, que es lo que deja copiar de un PDF', () => {
    assert.equal(limpiarDoi('  10.1000/abc  '), '10.1000/abc');
  });
});

test('lo que no es un DOI se rechaza en vez de consultarse', async (t) => {
  // Cada uno de estos habría sido una petición a OpenAlex que no podía salir
  // bien, y un «no encontrado» que el tesista tendría que interpretar.
  await t.test('un texto cualquiera', () => {
    assert.equal(limpiarDoi('no soy un doi'), null);
  });

  await t.test('un ISBN, que también sale impreso en la primera página', () => {
    assert.equal(limpiarDoi('978-3-16-148410-0'), null);
  });

  await t.test('un DOI a medias, sin sufijo', () => {
    assert.equal(limpiarDoi('10.1145/'), null);
    assert.equal(limpiarDoi('10.1145'), null);
  });

  await t.test('un prefijo que no llega a diez punto algo', () => {
    assert.equal(limpiarDoi('11.1145/abc'), null);
    assert.equal(limpiarDoi('10.12/abc'), null);
  });

  await t.test('nada', () => {
    assert.equal(limpiarDoi(''), null);
    assert.equal(limpiarDoi(null), null);
    assert.equal(limpiarDoi(undefined), null);
  });
});
