'use strict';

/**
 * Una tarea detrás de otra por clave. Lo que se prueba: que con la misma clave
 * no se solapan aunque lleguen juntas, que con claves distintas sí van a la vez,
 * que una que falla no bloquea a las siguientes, y que no se quedan claves
 * colgadas en memoria.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { enSerie, clavesEnMarcha } = require('../src/shared/utils/enSerie');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('con la misma clave no se solapan, y salen en el orden en que llegaron', async () => {
  let dentro = 0;
  let maximo = 0;
  const orden = [];

  await Promise.all(
    [30, 5, 15, 0].map((ms, i) =>
      enSerie('misma', async () => {
        dentro += 1;
        maximo = Math.max(maximo, dentro);
        await esperar(ms);
        orden.push(i);
        dentro -= 1;
      }),
    ),
  );

  assert.equal(maximo, 1);
  assert.deepEqual(orden, [0, 1, 2, 3]);
});

test('con claves distintas van a la vez', async () => {
  let dentro = 0;
  let maximo = 0;
  await Promise.all(
    ['a', 'b', 'c'].map((clave) =>
      enSerie(clave, async () => {
        dentro += 1;
        maximo = Math.max(maximo, dentro);
        await esperar(10);
        dentro -= 1;
      }),
    ),
  );
  assert.equal(maximo, 3);
});

test('una tarea que falla devuelve su error y no bloquea a la siguiente', async () => {
  const fallida = enSerie('fallos', async () => {
    throw new Error('se rompió');
  });
  const siguiente = enSerie('fallos', async () => 'hecho');

  await assert.rejects(fallida, /se rompió/);
  assert.equal(await siguiente, 'hecho');
});

test('al terminar no queda ninguna clave en memoria', async () => {
  await Promise.all([enSerie('x', async () => 1), enSerie('y', async () => 2)]);
  await esperar(0);
  assert.equal(clavesEnMarcha(), 0);
});
