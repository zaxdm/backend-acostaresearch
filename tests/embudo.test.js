'use strict';

/**
 * El embudo de venta: días de Lima, visitas sin duplicar y el resumen que
 * cuenta personas (no licencias) y mira la cohorte del periodo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const creadas = [];
let chocar = false;

sustituir('../src/lib/prisma', {
  visitaEmbudo: {
    create: async ({ data }) => {
      if (chocar) throw Object.assign(new Error('duplicada'), { code: 'P2002' });
      creadas.push(data);
      return data;
    },
    groupBy: async () => [{ visitante: 'a' }, { visitante: 'b' }, { visitante: 'c' }, { visitante: 'd' }],
  },
  user: { count: async () => 3 },
  payment: { groupBy: async () => [{ userId: 'u1' }, { userId: 'u2' }] },
  license: {
    findMany: async () => [
      // u1 compró tesis y artículo: es UNA persona en el embudo.
      { userId: 'u1', productCode: 'TESIS', callsTotal: 10, activationCodeId: null, grupoId: null },
      { userId: 'u1', productCode: 'ARTICULO', callsTotal: 0, activationCodeId: null, grupoId: null },
      { userId: 'u2', productCode: 'TESIS', callsTotal: 0, activationCodeId: 'c', grupoId: null },
      { userId: 'u3', productCode: 'TESIS', callsTotal: 4, activationCodeId: null, grupoId: 'g' },
    ],
  },
  project: {
    findMany: async () => [
      { userId: 'u1', productCode: 'TESIS' },
      // Una fase de un producto que no compró en el periodo no cuenta.
      { userId: 'u3', productCode: 'OTRO' },
    ],
  },
  referido: { groupBy: async () => [{ estado: 'PREMIADO', _count: { _all: 2 } }] },
  avisoAvance: { groupBy: async () => [{ tipo: 'SIN_CONECTAR', _count: { _all: 5 } }] },
});

const embudo = require('../src/modules/embudo/embudo.service');

test('el día es el de Lima: las 11 de la noche de Lima siguen siendo ese día', () => {
  assert.equal(
    embudo.diaDeLima(new Date('2026-10-11T03:30:00Z')).toISOString().slice(0, 10),
    '2026-10-10',
  );
  const { primerDia, hoy } = embudo.periodo(7, new Date('2026-10-10T15:00:00Z'));
  assert.equal(primerDia.toISOString().slice(0, 10), '2026-10-04');
  assert.equal(hoy.toISOString().slice(0, 10), '2026-10-10');
});

test('la visita se apunta una vez al día y una página desconocida se ignora', async () => {
  await embudo.registrarVisita({ visitante: 'v', pagina: 'planes' });
  await embudo.registrarVisita({ visitante: 'v', pagina: 'otra-cosa' });
  chocar = true;
  await embudo.registrarVisita({ visitante: 'v', pagina: 'planes' }); // no lanza
  chocar = false;
  assert.equal(creadas.length, 1);
});

test('el resumen cuenta personas y la cohorte del periodo', async () => {
  const r = await embudo.resumen({ dias: 30 });
  const valor = Object.fromEntries(r.pasos.map((p) => [p.id, p.valor]));

  assert.deepEqual(valor, { planes: 4, cuenta: 3, pago: 2, pagaron: 3, conectaron: 2, fase: 1 });
  assert.deepEqual(r.porVia, { web: 1, codigo: 1, grupo: 1 });
  assert.equal(r.activacion, 67);
  assert.equal(r.avance, 33);
  assert.equal(r.pasos[0].tasa, null);
  assert.equal(r.pasos[1].tasa, 75);
  assert.deepEqual(r.referidos, { PREMIADO: 2 });
  assert.deepEqual(r.avisos, { SIN_CONECTAR: 5 });
});
