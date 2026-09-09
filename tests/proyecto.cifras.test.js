'use strict';

/**
 * Que las cifras del texto salgan del cálculo.
 *
 * Un texto académico está lleno de números que no son resultados: años de
 * citas, «capítulo 3», el tamaño de la muestra. La mitad de estas pruebas
 * comprueba que NO se marquen, porque un aviso que salta con el año de una
 * cita se ignora entero y entonces tampoco avisa del p inventado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const cifras = require('../src/modules/projects/project.cifras');

const GUARDADAS = ['alfa de Cronbach = 0.87', 'R2 = 0.4231', 'p = 0.003', 'beta = -0.31', '42.5%'];

const sueltas = (texto) => cifras.sinRespaldo(texto, GUARDADAS).map((c) => c.bruto);

test('una cifra que sale del análisis no se marca', () => {
  assert.deepEqual(sueltas('La fiabilidad fue adecuada (alfa = 0,87).'), []);
});

test('una cifra inventada se marca', () => {
  assert.deepEqual(sueltas('La correlación fue significativa (p = 0,041).'), ['0,041']);
});

test('el redondeo del tesista no se marca', () => {
  // Un R² de 0,4231 se escribe «0,42». Marcarlo sería marcar la forma correcta
  // de citarlo.
  assert.deepEqual(sueltas('El modelo explicó el 0,42 de la varianza.'), []);
});

test('el año de una cita no es un resultado', () => {
  assert.deepEqual(sueltas('Como señaló García (2019), el fenómeno es persistente.'), []);
});

test('un entero suelto no es un resultado', () => {
  assert.deepEqual(sueltas('Participaron 120 estudiantes de los 340 matriculados.'), []);
});

test('un porcentaje sí, aunque sea entero', () => {
  assert.deepEqual(sueltas('El 63% de la muestra abandonó el primer ciclo.'), ['63%']);
});

test('un porcentaje que sí está guardado no se marca', () => {
  assert.deepEqual(sueltas('El 42,5% de la muestra abandonó.'), []);
});

test('los negativos se comparan con su signo', () => {
  assert.deepEqual(sueltas('El coeficiente fue negativo (beta = -0,31).'), []);
  assert.deepEqual(sueltas('El coeficiente fue positivo (beta = 0,31).'), ['0,31']);
});

test('la misma cifra repetida se marca una vez', () => {
  assert.deepEqual(sueltas('Salió 0,041 aquí. Y 0,041 allá. Y otra vez 0,041.'), ['0,041']);
});

test('sin cifras guardadas no se marca nada', () => {
  // Sin nada contra qué comparar, marcarlo todo sería el mismo error que
  // comparar a un comprador nuevo con un histórico que no tiene.
  assert.deepEqual(cifras.sinRespaldo('Cualquier cosa con 0,041 y 0,99', []), []);
});

test('el aviso trae el contexto para poder encontrarlo', () => {
  const [suelta] = cifras.sinRespaldo(
    'El análisis de regresión mostró que la relación era significativa (p = 0,041) en el modelo.',
    GUARDADAS,
  );

  assert.equal(suelta.bruto, '0,041');
  assert.match(suelta.contexto, /regresión/);
});

test('da igual el punto o la coma decimal', () => {
  assert.deepEqual(sueltas('Alfa de 0.87 y alfa de 0,87.'), []);
});

test('las cifras de un texto se detectan aunque vayan pegadas a signos', () => {
  const encontradas = cifras.cifrasDe('Fue (p<0,05) y también p≤0,01, además de 33,3%.');
  const valores = encontradas.map((c) => c.bruto);

  assert.ok(valores.includes('0,05'));
  assert.ok(valores.includes('0,01'));
  assert.ok(valores.includes('33,3%'));
});
