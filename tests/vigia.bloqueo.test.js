'use strict';

/**
 * El vigía de bloqueos: anota cuando el reloj llega tarde más del umbral.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearVigiaDeBloqueo } = require('../src/lib/vigiaBloqueo');

function reloj(inicio = 0) {
  let t = inicio;
  return { ahora: () => t, avanzar: (ms) => (t += ms) };
}

test('si el reloj llega a su hora no se anota nada', () => {
  const r = reloj();
  const anotados = [];
  const comprobar = crearVigiaDeBloqueo({ anotar: (ms) => anotados.push(ms), ahora: r.ahora, intervaloMs: 500 });

  for (let i = 0; i < 10; i += 1) {
    r.avanzar(500 + 30);
    comprobar();
  }

  assert.deepEqual(anotados, []);
});

test('un hilo parado 20 s se anota una vez, con su duración', () => {
  const r = reloj();
  const anotados = [];
  const comprobar = crearVigiaDeBloqueo({ anotar: (ms) => anotados.push(ms), ahora: r.ahora, intervaloMs: 500 });

  r.avanzar(500);
  comprobar();
  r.avanzar(500 + 20_000);
  comprobar();
  r.avanzar(500);
  comprobar();

  assert.deepEqual(anotados, [20_000]);
});

test('por debajo del umbral no avisa', () => {
  const r = reloj();
  const anotados = [];
  const comprobar = crearVigiaDeBloqueo({ anotar: (ms) => anotados.push(ms), ahora: r.ahora, intervaloMs: 500, umbralMs: 2000 });

  r.avanzar(500 + 1999);
  comprobar();

  assert.deepEqual(anotados, []);
});
