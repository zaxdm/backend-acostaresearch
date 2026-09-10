'use strict';

/**
 * Cómo se le cuenta el cupo al asistente.
 *
 * Esto existe por un error real: el panel decía «500 consultas por día», la
 * licencia guardaba 500 al día, y el asistente le dijo al comprador que tenía
 * «500 consultas al mes». El dato nunca estuvo mal — la frase era «Hoy llevas 0
 * de 500 consultas», que es cierta y no dice la palabra «día» junto al número.
 * Quien la resume le pone el periodo que le parece, y en software lo normal es
 * mensual.
 *
 * La regla que fijan estas pruebas: **la cantidad y su unidad no se separan
 * nunca.**
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { describirCupo } = require('../src/modules/licensing/license.limits');

function uso(limits, contadores = {}) {
  return {
    callsToday: 0,
    callsMonth: 0,
    callsLifetime: 0,
    ...contadores,
    limits: {
      callsPerDay: 0,
      callsPerMonth: 0,
      costCentsPerMonth: 0,
      callsLimitTotal: 0,
      costCentsLimitTotal: 0,
      ...limits,
    },
  };
}

test('un tope diario dice DÍA en la misma frase que el número', () => {
  const [linea] = describirCupo(uso({ callsPerDay: 500 }, { callsToday: 12 }));

  assert.match(linea, /500 consultas CADA DÍA/);
  assert.match(linea, /Hoy lleva 12/);
  // Lo que no puede pasar bajo ningún concepto.
  assert.ok(!/mes/i.test(linea), 'un tope diario no puede nombrar el mes');
});

test('un tope mensual dice MES', () => {
  const [linea] = describirCupo(uso({ callsPerMonth: 3000 }, { callsMonth: 240 }));

  assert.match(linea, /3000 consultas CADA MES/);
  assert.match(linea, /Este mes lleva 240/);
  assert.ok(!/d[íi]a/i.test(linea), 'un tope mensual no puede nombrar el día');
});

test('sin topes no se dice nada', () => {
  // «0 de 0» no informa de nada y preocupa.
  assert.deepEqual(describirCupo(uso({})), []);
});

test('el tope de por vida se menciona, que antes no existía en el texto', () => {
  // Alguien podía agotarlo sin haber visto nunca que estaba ahí.
  const lineas = describirCupo(uso({ callsLimitTotal: 2000 }, { callsLifetime: 1850 }));

  assert.equal(lineas.length, 1);
  assert.match(lineas[0], /2000 consultas en toda su vida/);
  assert.match(lineas[0], /Lleva 1850/);
});

test('con los tres topes salen las tres líneas, cada una con su periodo', () => {
  const lineas = describirCupo(
    uso(
      { callsPerDay: 500, callsPerMonth: 3000, callsLimitTotal: 20000 },
      { callsToday: 4, callsMonth: 90, callsLifetime: 1200 },
    ),
  );

  assert.equal(lineas.length, 3);
  assert.match(lineas[0], /CADA DÍA/);
  assert.match(lineas[1], /CADA MES/);
  assert.match(lineas[2], /toda su vida/);
});

test('el número del tope aparece dos veces en la frase, a propósito', () => {
  // Una vez al declararlo y otra al decir cuánto lleva. Así, aunque alguien
  // se quede solo con la segunda mitad, el número sigue teniendo su periodo
  // delante en la misma frase.
  const [linea] = describirCupo(uso({ callsPerDay: 500 }, { callsToday: 12 }));

  assert.equal(linea.match(/500/g).length, 2);
});
