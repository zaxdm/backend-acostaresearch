'use strict';

/**
 * Qué gasta cupo y qué no.
 *
 * DE DÓNDE SALE ESTA PRUEBA
 * -------------------------
 * Del 22-sep-2026. El dueño vio «7 de 10 este mes» con la lista llena de
 * documentos que decían «No se completó · No se descontó de tu membresía», y
 * dio por hecho que los fallos le estaban gastando el cupo. No era así —el 7
 * eran los que le QUEDABAN, no los gastados—, pero que haya que explicarlo ya
 * es motivo suficiente para dejar la regla escrita donde no se pueda torcer
 * sin que salte algo.
 *
 * LA REGLA
 * --------
 *   · FALLIDO no gasta NUNCA. Lo que no salió no se cobra, ni en dinero ni en
 *     cupo. Es lo que se le promete en la pantalla y en el correo.
 *   · EN_COLA y EN_CURSO SÍ gastan, aunque todavía no hayan terminado. Si no,
 *     quien suba diez documentos en diez segundos se salta el tope entero:
 *     `recibirEncargo` mira el cupo ANTES de crear la fila, y ninguna de las
 *     diez habría terminado todavía.
 *   · Solo los de la ventana en curso de ESA membresía.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repository = require('../src/modules/preparar/preparar.repository');
const membresia = require('../src/modules/preparar/preparar.membresia');

/** Un Prisma de mentira que apunta la consulta en vez de hacerla. */
function prismaFalso(devuelve = 0) {
  const visto = {};
  return {
    visto,
    preparacion: {
      count(consulta) {
        Object.assign(visto, consulta);
        return Promise.resolve(devuelve);
      },
    },
  };
}

test('un documento fallido no gasta cupo', async () => {
  const falso = prismaFalso(3);
  const desde = new Date('2026-09-21T00:00:00Z');
  const hasta = new Date('2026-10-21T00:00:00Z');

  await repository.usadosEn('pack-1', desde, hasta, falso);

  assert.deepEqual(falso.visto.where.estado, { not: 'FALLIDO' });
});

test('los que están en cola o en curso sí gastan: si no, diez a la vez se saltan el tope', async () => {
  const falso = prismaFalso();
  await repository.usadosEn('pack-1', new Date(0), new Date(), falso);

  // La condición es «todo menos FALLIDO», no «solo LISTO»: eso es lo que hace
  // que un EN_CURSO cuente mientras trabaja.
  assert.deepEqual(falso.visto.where.estado, { not: 'FALLIDO' });
  assert.notDeepEqual(falso.visto.where.estado, 'LISTO');
});

test('solo cuenta lo de esa membresía y lo de la ventana en curso', async () => {
  const falso = prismaFalso();
  const desde = new Date('2026-09-21T00:00:00Z');
  const hasta = new Date('2026-10-21T00:00:00Z');

  await repository.usadosEn('pack-7', desde, hasta, falso);

  assert.equal(falso.visto.where.docPackId, 'pack-7');
  assert.deepEqual(falso.visto.where.createdAt, { gte: desde, lt: hasta });
});

test('lo que se le enseña: lo gastado y lo que le queda, sin mezclarlos', () => {
  const pack = {
    docsPorMes: 10,
    activatedAt: new Date('2026-09-21T00:00:00Z'),
    expiresAt: new Date('2026-12-21T00:00:00Z'),
  };

  const cupo = membresia.cupoDe(pack, 3, new Date('2026-09-22T18:00:00Z'));

  assert.equal(cupo.total, 10);
  assert.equal(cupo.usados, 3);
  assert.equal(cupo.restantes, 7);
});

test('gastar más de la cuenta no deja los restantes en negativo', () => {
  const pack = {
    docsPorMes: 10,
    activatedAt: new Date('2026-09-21T00:00:00Z'),
    expiresAt: new Date('2026-12-21T00:00:00Z'),
  };

  const cupo = membresia.cupoDe(pack, 14, new Date('2026-09-22T18:00:00Z'));

  assert.equal(cupo.restantes, 0);
});
