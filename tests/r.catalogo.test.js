'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { comoSeLee } = require('../src/modules/r/r.catalogo');

test('el alfa trae cómo se lee el alfa', () => {
  const lecturas = comoSeLee('alfa_de_cronbach(datos[, c("p1", "p2")])');
  assert.equal(lecturas.length, 1);
  assert.match(lecturas[0], /0,70/);
});

test('un Spearman no se explica además como Pearson', () => {
  const lecturas = comoSeLee('cor.test(datos$a, datos$b, method = "spearman")');
  assert.equal(lecturas.length, 1);
  assert.match(lecturas[0], /rho/);
});

test('un cor.test sin método se explica como correlación', () => {
  assert.match(comoSeLee('cor.test(datos$a, datos$b)')[0], /relación significativa/);
});

test('varias pruebas en una orden, cada una una vez y en orden', () => {
  const lecturas = comoSeLee('normalidad(datos$a)\nnormalidad(datos$b)\nt.test(a ~ sexo, datos)');
  assert.equal(lecturas.length, 2);
  assert.match(lecturas[0], /Shapiro/);
  assert.match(lecturas[1], /t de Student/);
});

test('código sin pruebas no trae lecturas', () => {
  assert.deepEqual(comoSeLee('datos$x <- datos$a * 2'), []);
  assert.deepEqual(comoSeLee(undefined), []);
});
