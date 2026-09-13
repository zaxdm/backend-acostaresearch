'use strict';

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');

const { crearVigia } = require('../src/lib/vigiaBase');

/**
 * El vigilante que avisa al móvil cuando la base se cae. Nace de descubrir que,
 * con la pantalla de mantenimiento puesta, el aviso contado a partir de las
 * peticiones no sonaba nunca con una sola persona en la web.
 *
 * Los latidos van con el reloj a mano: cada uno es una comprobación de las que
 * el servidor hace cada treinta segundos.
 */

const P1001 = Object.assign(new Error('prisma'), { code: 'P1001' });

function montaje({ comprobar } = {}) {
  const base = { fallo: null };
  const avisos = [];
  const latido = crearVigia({
    comprobar:
      comprobar ??
      (async () => {
        if (base.fallo) throw base.fallo;
      }),
    avisar: (aviso) => avisos.push(aviso),
    tiempoLimiteMs: 20,
  });
  return { base, avisos, latido };
}

test('con la base arriba no suena nada', async () => {
  const { avisos, latido } = montaje();
  for (let t = 0; t < 5 * 60_000; t += 30_000) await latido(t);
  assert.equal(avisos.length, 0);
});

test('un fallo suelto no avisa, ni tampoco que la base «vuelva» después', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = P1001;
  await latido(0);
  base.fallo = null;
  await latido(30_000);
  assert.equal(avisos.length, 0);
});

test('dos comprobaciones fallidas seguidas avisan, con el código y a prioridad máxima', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = P1001;
  await latido(0);
  await latido(30_000);

  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].titulo, 'La base de datos no responde');
  assert.match(avisos[0].mensaje, /P1001/);
  assert.match(avisos[0].mensaje, /hace 30 s/);
  assert.equal(avisos[0].prioridad, 5);
});

test('un corte largo avisa una vez, no con cada comprobación', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = P1001;
  for (let t = 0; t < 10 * 60_000; t += 30_000) await latido(t);
  assert.equal(avisos.length, 1);
});

test('cuando la base vuelve se avisa, y un corte nuevo vuelve a sonar', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = P1001;
  for (let t = 0; t < 4 * 60_000; t += 30_000) await latido(t);
  base.fallo = null;
  await latido(4 * 60_000);

  assert.equal(avisos.length, 2);
  assert.equal(avisos[1].titulo, 'La base de datos volvió');
  assert.match(avisos[1].mensaje, /4 min/);

  base.fallo = P1001;
  await latido(5 * 60_000);
  await latido(5 * 60_000 + 30_000);
  assert.equal(avisos.length, 3);
  assert.equal(avisos[2].titulo, 'La base de datos no responde');
});

test('una base que se queda colgada sin contestar cuenta como caída', async () => {
  const { avisos, latido } = montaje({ comprobar: () => new Promise(() => {}) });
  await latido(0);
  await latido(30_000);

  assert.equal(avisos.length, 1);
  assert.match(avisos[0].mensaje, /sin respuesta/);
});

test('el código también sale cuando Prisma lo trae en errorCode', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = new Prisma.PrismaClientInitializationError(
    "Can't reach database server",
    Prisma.prismaVersion.client,
    'P1001',
  );
  await latido(0);
  await latido(30_000);

  assert.match(avisos[0].mensaje, /P1001/);
});
