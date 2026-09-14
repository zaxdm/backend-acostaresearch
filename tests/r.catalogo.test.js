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

test('el AFE, el AFC y Levene traen sus criterios', () => {
  assert.match(comoSeLee('fa(datos[, 1:6], nfactors = 2)')[0], /KMO/);
  assert.match(comoSeLee('factanal(datos[, 1:6], factors = 2)')[0], /KMO/);
  assert.match(comoSeLee('ajuste <- lavaan::cfa(modelo, data = datos)')[0], /RMSEA/);
  assert.match(comoSeLee('car::leveneTest(y ~ g, data = datos)')[0], /Welch/);
});

test('psych::alpha se explica como el alfa de la casa', () => {
  assert.match(comoSeLee('psych::alpha(datos[, 1:4])')[0], /0,70/);
});

test('las pruebas de otras carreras traen su criterio', () => {
  const casos = [
    ['pwr::pwr.t.test(d = 0.5, power = 0.8)', /POR GRUPO/],
    ['pROC::roc(caso, puntaje)', /AUC/],
    ['epitools::oddsratio(tabla)', /incluye el 1/],
    ['survdiff(Surv(t, e) ~ g, datos)', /log-rank/],
    ['metafor::rma(yi, vi, data = d)', /I²/],
    ['car::vif(modelo)', /multicolinealidad/],
    ['lmtest::bptest(modelo)', /heterocedasticidad/],
    ['plm::phtest(fijos, aleatorios)', /Hausman/],
    ['tseries::adf.test(serie)', /estacionaria/],
    ['vegan::diversity(abund, "shannon")', /Shannon/],
    ['FactoMineR::PCA(datos)', /autovalor/],
  ];
  for (const [codigo, criterio] of casos) {
    assert.ok(comoSeLee(codigo).some((l) => criterio.test(l)), codigo);
  }
});

test('código sin pruebas no trae lecturas', () => {
  assert.deepEqual(comoSeLee('datos$x <- datos$a * 2'), []);
  assert.deepEqual(comoSeLee(undefined), []);
});
