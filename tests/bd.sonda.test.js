'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearSonda } = require('../src/lib/sondaBase');

/**
 * La sonda que consulta la pantalla de mantenimiento de la web. Lo que importa
 * es que muchas pestañas preguntando no se conviertan en muchas consultas
 * contra una base que se está levantando.
 */

function consultaFalsa() {
  const falsa = {
    llamadas: 0,
    fallo: null,
    consultar: async () => {
      falsa.llamadas += 1;
      if (falsa.fallo) throw falsa.fallo;
    },
  };
  return falsa;
}

test('con la base arriba, la sonda contesta sin lanzar', async () => {
  const base = consultaFalsa();
  const comprobar = crearSonda({ consultar: base.consultar });

  await comprobar(0);
  assert.equal(base.llamadas, 1);
});

test('con la base caída, la sonda lanza el mismo error que dio la base', async () => {
  const base = consultaFalsa();
  base.fallo = Object.assign(new Error('prisma'), { code: 'P1001' });
  const comprobar = crearSonda({ consultar: base.consultar });

  await assert.rejects(comprobar(0), { code: 'P1001' });
});

test('dentro de la vigencia no se vuelve a preguntar a la base', async () => {
  const base = consultaFalsa();
  base.fallo = Object.assign(new Error('prisma'), { code: 'P1001' });
  const comprobar = crearSonda({ consultar: base.consultar, vigenciaMs: 10_000 });

  for (let t = 0; t < 10_000; t += 500) {
    await assert.rejects(comprobar(t), { code: 'P1001' });
  }
  assert.equal(base.llamadas, 1);
});

test('pasada la vigencia se pregunta otra vez, y así se ve que la base volvió', async () => {
  const base = consultaFalsa();
  base.fallo = Object.assign(new Error('prisma'), { code: 'P1001' });
  const comprobar = crearSonda({ consultar: base.consultar, vigenciaMs: 10_000 });

  await assert.rejects(comprobar(0));
  base.fallo = null;
  await comprobar(10_000);
  assert.equal(base.llamadas, 2);
});

test('varias peticiones a la vez comparten una sola consulta', async () => {
  const base = consultaFalsa();
  const comprobar = crearSonda({ consultar: base.consultar });

  await Promise.all([comprobar(0), comprobar(0), comprobar(0)]);
  assert.equal(base.llamadas, 1);
});
