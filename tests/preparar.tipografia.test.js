'use strict';

/**
 * Los símbolos que arregla el código, sin preguntar al modelo.
 *
 * Salen de comparar, el 24-sep-2026, nuestra edición con cinco manuscritos de
 * Rubriq: un tercio de sus cambios son de esta clase y nosotros no hacíamos
 * ninguno. Tan importante como lo que se arregla es lo que NO se toca: un
 * asterisco de significación, un comodín de búsqueda, un DOI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { arreglar } = require('../src/modules/preparar/preparar.tipografia');

test('los restos de Markdown pegados en Word se quitan', () => {
  assert.equal(arreglar('## Annex 1. Consistency matrix'), 'Annex 1. Consistency matrix');
  assert.equal(arreglar('Table 1.1** *Consistency matrix'), 'Table 1.1 Consistency matrix');
});

test('los asteriscos de significación y los comodines de búsqueda se quedan', () => {
  const nota = 'CI = 95% confidence interval; ***p < 0.001; **p < 0.01; r = .45**';
  assert.equal(arreglar(nota), nota);
  const busqueda = 'TS = ("musical identity" AND (trend* OR student*))';
  assert.equal(arreglar(busqueda), busqueda);
});

test('el guion que no se parte (U+2011) vuelve a ser un guion', () => {
  assert.equal(arreglar('Alsumait and Al‑Osaimi (2009), Scopus‑indexed'), 'Alsumait and Al-Osaimi (2009), Scopus-indexed');
});

test('los rangos van con raya corta; los identificadores y las fechas no se tocan', () => {
  assert.equal(arreglar('in the 18-22 age group, pp. 25-32, (1--3)'), 'in the 18–22 age group, pp. 25–32, (1–3)');
  const intactos = 'ISBN 978-3-16, on 2021-03-15, COVID-19, https://doi.org/10.4067/s0718-50062021000600025';
  assert.equal(arreglar(intactos), intactos);
});

test('las pruebas con dos apellidos llevan raya corta', () => {
  assert.equal(arreglar('Kruskal-Wallis, Mann-Whitney and Kaiser-Meyer-Olkin'), 'Kruskal–Wallis, Mann–Whitney and Kaiser–Meyer–Olkin');
});

test('apóstrofo, raya y espacios', () => {
  assert.equal(arreglar('Cohen´s cutoff'), 'Cohen’s cutoff');
  assert.equal(arreglar('teaching practice — an intersection — and'), 'teaching practice—an intersection—and');
  assert.equal(arreglar('constituted 68.5%  of the students ( n = 5 ) , and'), 'constituted 68.5% of the students (n = 5), and');
});

test('las cifras no cambian nunca', () => {
  const texto = 'Values of 0.083 and 1.982 ( p < .05 ) in 18-22 year olds, 1,613 articles.';
  const cifras = (t) => (t.match(/\d+/g) ?? []).join('|');
  assert.equal(cifras(arreglar(texto)), cifras(texto));
});

test('una cita pegada a la palabra de delante se separa; una fórmula no', () => {
  assert.equal(
    arreglar('to use AI(Ismaniati et al., 2025; Xiong & Zhang, 2025) , the'),
    'to use AI (Ismaniati et al., 2025; Xiong & Zhang, 2025), the',
  );
  for (const intacto of ['cal viva Ca(OH)2 al 5%', 'la función f(x) y g(Y)', 'Hernández (2014)']) {
    assert.equal(arreglar(intacto), intacto);
  }
});
