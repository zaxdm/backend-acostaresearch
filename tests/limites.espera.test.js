'use strict';

/**
 * Cuánto tiene que esperar alguien que chocó con un límite.
 *
 * «Espera unos minutos» no le decía nada: con un cubo de diez minutos, quien
 * esperaba uno volvía a chocar y quien esperaba diez esperó de más. Lo que se
 * comprueba aquí es que el aviso dice el número, en la unidad que se entiende.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { cuantoFalta } = require('../src/middlewares/rateLimit');

const dentroDe = (ms) => new Date(Date.now() + ms);

test('con minutos por delante, dice cuántos, redondeando hacia arriba', () => {
  assert.equal(cuantoFalta(dentroDe(4 * 60_000 + 10_000)), 'Vuelve a intentarlo en 5 minutos.');
  assert.equal(cuantoFalta(dentroDe(60_000 + 1_000)), 'Vuelve a intentarlo en 2 minutos.');
});

test('pasado el minuto se redondea hacia arriba: mejor esperar de más que volver a chocar', () => {
  assert.equal(cuantoFalta(dentroDe(90_000)), 'Vuelve a intentarlo en 2 minutos.');
});

test('con menos de un minuto, en segundos', () => {
  assert.equal(cuantoFalta(dentroDe(30_000)), 'Vuelve a intentarlo en 30 segundos.');
});

test('sin hora de reinicio, o ya pasada, no se inventa un número', () => {
  assert.equal(cuantoFalta(undefined), 'Vuelve a intentarlo en un momento.');
  assert.equal(cuantoFalta(new Date(Date.now() - 1000)), 'Vuelve a intentarlo en un momento.');
});
