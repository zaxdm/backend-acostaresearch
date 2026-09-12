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

// ── El formato APA, la notación científica y las líneas con varias cifras ─────
//
// APA 7 escribe sin cero delante lo que no puede pasar de 1: r = .51, p < .001,
// alfa = .886. Así lo escribe Claude. Antes, esas cifras no se detectaban en el
// texto —un «r = .73» inventado pasaba el repaso— y al guardarlas «.886» se leía
// como 886. El control estaba apagado justo para el formato correcto.

test('un decimal sin cero delante es una cifra, y si es inventado se marca', () => {
  const marcadas = cifras.sinRespaldo('La correlación fue r = .73.', ['r de Pearson = 0.5112']);

  assert.deepEqual(marcadas.map((c) => c.bruto), ['.73']);
});

test('y si sale del análisis no se marca, se guarde y se escriba como se escriba', () => {
  assert.deepEqual(cifras.sinRespaldo('Se obtuvo r = .51.', ['r = 0.5112']), []);
  assert.deepEqual(cifras.sinRespaldo('Se obtuvo r = 0,51.', ['r = .5112']), []);
});

test('una línea guardada con varias cifras las protege TODAS, no solo la última', () => {
  // Así guarda un asistente cuando agrupa. Antes solo contaba el .2613, y
  // «r = .51» salía marcado como inventado aunque estaba en la misma línea.
  const guardadas = ['Pearson: r = .511, p < .001, IC 95% [.296, .677], r2 = .2613'];
  const texto = 'La relación fue r = .51 (p < .001), IC 95% [.296, .677], con r2 = .26.';

  assert.deepEqual(cifras.sinRespaldo(texto, guardadas), []);
});

test('el valor de p en notación científica se lee con su exponente', () => {
  // R escribe «p-value = 2.996e-05». Antes esa cifra se guardaba como -5.
  assert.ok(cifras.valoresGuardados(['p = 2.996e-05']).includes(2.996e-5));
  assert.deepEqual(cifras.sinRespaldo('Fue significativa, p = 3e-05.', ['p = 2.996e-05']), []);
});

test('una media que parece un año no se tira como si fuera una cita', () => {
  // «M = 20.13» es una edad media corriente. Quitándole el punto se convertía
  // en 2013 y se descartaba.
  assert.deepEqual(cifras.cifrasDe('La edad media fue M = 20.13 años.').map((c) => c.bruto), ['20.13']);
});
