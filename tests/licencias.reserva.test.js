'use strict';

/**
 * La reserva del cupo: que «5 al día» sean cinco, también cuando llegan a la vez.
 *
 * El tope se comprobaba al empezar y se sumaba al terminar. Entre medias cabe
 * todo lo que tarda la llamada, y dos lanzadas a la vez leían «4 de 5» y
 * pasaban las dos. Estas pruebas fijan que la comprobación y la suma son una
 * sola operación.
 *
 * La base es falsa, pero se comporta en lo que importa como MySQL: cada
 * `updateMany` evalúa su condición y escribe sin que otra operación se cuele en
 * medio, y entre una operación y la siguiente sí pueden entrar otras.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const filas = new Map();

function cumple(fila, where) {
  return Object.entries(where).every(([campo, condicion]) => {
    const valor = fila[campo];
    if (condicion === null || typeof condicion !== 'object') return valor === condicion;
    if ('not' in condicion && valor === condicion.not) return false;
    if ('lt' in condicion && !(valor < condicion.lt)) return false;
    if ('gt' in condicion && !(valor > condicion.gt)) return false;
    return true;
  });
}

function aplicar(fila, data) {
  for (const [campo, valor] of Object.entries(data)) {
    if (valor && typeof valor === 'object' && 'increment' in valor) fila[campo] += valor.increment;
    else if (valor && typeof valor === 'object' && 'decrement' in valor) fila[campo] -= valor.decrement;
    else fila[campo] = valor;
  }
}

// Cede el turno antes de cada operación, para que las llamadas simultáneas se
// intercalen de verdad.
const turno = () => new Promise((resuelve) => setImmediate(resuelve));

const prismaFalso = {
  licenseCounter: {
    async findUnique({ where }) {
      await turno();
      const fila = filas.get(where.licenseId);
      return fila ? { ...fila } : null;
    },
    async create({ data }) {
      await turno();
      if (filas.has(data.licenseId)) throw Object.assign(new Error('duplicada'), { code: 'P2002' });
      const fila = {
        callsToday: 0,
        callsMonth: 0,
        costCentsToday: 0,
        costCentsMonth: 0,
        callsLifetime: 0,
        costCentsLifetime: 0,
        ...data,
      };
      filas.set(data.licenseId, fila);
      return { ...fila };
    },
    async updateMany({ where, data }) {
      await turno();
      const fila = filas.get(where.licenseId);
      if (!fila || !cumple(fila, where)) return { count: 0 };
      aplicar(fila, data);
      return { count: 1 };
    },
  },
};

const rutaPrisma = require.resolve('../src/lib/prisma');
require.cache[rutaPrisma] = { id: rutaPrisma, filename: rutaPrisma, loaded: true, exports: prismaFalso };

const limites = require('../src/modules/licensing/license.limits');

let siguiente = 0;
function licencia(topes = {}) {
  siguiente += 1;
  return {
    id: `licencia-${siguiente}`,
    callsPerDay: 0,
    callsPerMonth: 0,
    costCentsPerMonth: 0,
    callsLimitTotal: 0,
    costCentsLimitTotal: 0,
    ...topes,
  };
}

const MEDIODIA = new Date('2026-09-13T17:00:00Z');
const MANANA = new Date('2026-09-14T17:00:00Z');

test('con tope de 5 al día, la sexta consulta no pasa', async () => {
  const l = licencia({ callsPerDay: 5 });
  const resultados = [];
  for (let i = 0; i < 7; i += 1) resultados.push(await limites.reservar(l, MEDIODIA));

  assert.deepEqual(
    resultados.map((r) => r.permitido),
    [true, true, true, true, true, false, false],
  );
  assert.match(resultados[5].motivo, /límite de 5 consultas de hoy/);
  assert.equal(filas.get(l.id).callsToday, 5);
});

test('siete consultas lanzadas a la vez con tope de 5 dejan pasar exactamente 5', async () => {
  const l = licencia({ callsPerDay: 5 });
  const resultados = await Promise.all(
    Array.from({ length: 7 }, () => limites.reservar(l, MEDIODIA)),
  );

  assert.equal(resultados.filter((r) => r.permitido).length, 5);
  assert.equal(filas.get(l.id).callsToday, 5);
  assert.equal(filas.get(l.id).callsLifetime, 5);
  for (const rechazada of resultados.filter((r) => !r.permitido)) {
    assert.ok(rechazada.motivo, 'la rechazada tiene que decir por qué');
  }
});

test('una consulta que falló se devuelve y deja sitio a otra', async () => {
  const l = licencia({ callsPerDay: 5 });
  const reservas = [];
  for (let i = 0; i < 5; i += 1) reservas.push(await limites.reservar(l, MEDIODIA));
  assert.equal((await limites.reservar(l, MEDIODIA)).permitido, false);

  await limites.liberar(reservas[4].reserva);

  assert.equal((await limites.reservar(l, MEDIODIA)).permitido, true);
  assert.equal(filas.get(l.id).callsToday, 5);
});

test('al día siguiente vuelve a haber cupo, y el total sigue sumando', async () => {
  const l = licencia({ callsPerDay: 5 });
  for (let i = 0; i < 5; i += 1) await limites.reservar(l, MEDIODIA);

  const manana = await limites.reservar(l, MANANA);

  assert.equal(manana.permitido, true);
  assert.equal(filas.get(l.id).callsToday, 1);
  assert.equal(filas.get(l.id).callsLifetime, 6);
});

test('devolver una consulta de ayer no toca el cupo de hoy', async () => {
  const l = licencia({ callsPerDay: 5 });
  const ayer = await limites.reservar(l, MEDIODIA);
  await limites.reservar(l, MANANA);

  await limites.liberar(ayer.reserva);

  assert.equal(filas.get(l.id).callsToday, 1);
});

test('0 es sin tope: no se rechaza ninguna', async () => {
  const l = licencia();
  const resultados = await Promise.all(
    Array.from({ length: 20 }, () => limites.reservar(l, MEDIODIA)),
  );
  assert.ok(resultados.every((r) => r.permitido));
});

test('el coste se suma aparte y no cuenta otra consulta', async () => {
  const l = licencia({ callsPerDay: 5 });
  await limites.reservar(l, MEDIODIA);

  await limites.anotarCoste(l.id, 12, MEDIODIA);

  const fila = filas.get(l.id);
  assert.equal(fila.callsToday, 1);
  assert.equal(fila.costCentsToday, 12);
  assert.equal(fila.costCentsLifetime, 12);
});
