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

test('un corte de menos de diez minutos avisa una vez, no con cada comprobación', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = P1001;
  for (let t = 0; t < 10 * 60_000; t += 30_000) await latido(t);
  assert.equal(avisos.length, 1);
});

test('un corte largo recuerda cada diez minutos que sigue caída', async () => {
  const { base, avisos, latido } = montaje();
  base.fallo = P1001;
  // 40 minutos caída, como el 16-nov: aviso a los 30 s y recordatorios a los
  // 10 min 30 s, 20 min 30 s y 30 min 30 s.
  for (let t = 0; t < 40 * 60_000; t += 30_000) await latido(t);

  assert.equal(avisos.length, 4);
  assert.equal(avisos[0].titulo, 'La base de datos no responde');
  for (const recordatorio of avisos.slice(1)) {
    assert.equal(recordatorio.titulo, 'La base de datos sigue sin responder');
    assert.equal(recordatorio.prioridad, 5);
  }
  assert.match(avisos[3].mensaje, /Lleva 31 min caída \(P1001\)/);

  base.fallo = null;
  await latido(40 * 60_000);
  assert.equal(avisos.length, 5);
  assert.equal(avisos[4].titulo, 'La base de datos volvió');
  assert.match(avisos[4].mensaje, /40 min/);
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
