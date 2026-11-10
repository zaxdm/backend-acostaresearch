'use strict';

/**
 * Planes de Epicuro.ai (10-nov-2026): una fila por cuenta.
 *
 * Lo que se fija: comprar crea el plan por sus días; renovar SUMA a lo que le
 * queda; si ya venció, empieza hoy; cambiar de nivel conserva los días; el
 * reembolso resta los días y, si no queda nada, vence ahora; y Epicuro solo ve
 * un plan vigente.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const filas = new Map();
const usuarios = new Map();
const tabla = {
  findUnique: async ({ where }) => filas.get(where.userId) ?? null,
  create: async ({ data }) => {
    const fila = { id: `ep-${filas.size + 1}`, activatedAt: new Date(), ...data };
    filas.set(data.userId, fila);
    return fila;
  },
  update: async ({ where, data }) => Object.assign(filas.get(where.userId), data),
};
sustituir('../src/lib/prisma', {
  epicuroPlan: tabla,
  user: {
    findUnique: async ({ where }) => {
      const u = usuarios.get(where.email);
      return u ? { role: u.role ?? 'USER', epicuroPlan: filas.get(u.id) ?? null } : null;
    },
  },
});

const tx = { epicuroPlan: tabla };
const planes = require('../src/modules/acostaia/acostaia.planes');

const DIA = 24 * 60 * 60 * 1000;
const ESTANDAR = { code: 'EPICURO_ESTANDAR', kind: 'EPICURO', productCode: 'ESTANDAR', durationDays: 30 };
const POWER = { code: 'EPICURO_POWER', kind: 'EPICURO', productCode: 'POWER', durationDays: 30 };
const dias = (fecha) => Math.round((new Date(fecha).getTime() - Date.now()) / DIA);

test.beforeEach(() => {
  filas.clear();
  usuarios.clear();
});

test('solo los planes EPICURO son de Epicuro', () => {
  assert.equal(planes.esPlanDeEpicuro(ESTANDAR), true);
  assert.equal(planes.esPlanDeEpicuro({ kind: 'LICENSE' }), false);
  assert.equal(planes.esPlanDeEpicuro(undefined), false);
});

test('comprar crea el plan por 30 días; renovar suma a lo que le queda', async () => {
  const primera = await planes.entregar({ userId: 'u1', plan: ESTANDAR }, tx);
  assert.equal(primera.nivel, 'ESTANDAR');
  assert.equal(primera.renovada, false);
  assert.equal(dias(primera.expiresAt), 30);

  const segunda = await planes.entregar({ userId: 'u1', plan: ESTANDAR }, tx);
  assert.equal(segunda.renovada, true);
  assert.equal(dias(segunda.expiresAt), 60);
  assert.equal(filas.size, 1, 'una sola fila por cuenta');
});

test('si ya venció, el plan nuevo empieza hoy', async () => {
  filas.set('u1', { id: 'ep-1', userId: 'u1', nivel: 'ESTANDAR', expiresAt: new Date(Date.now() - 10 * DIA) });
  const r = await planes.entregar({ userId: 'u1', plan: ESTANDAR }, tx);
  assert.equal(r.renovada, false);
  assert.equal(dias(r.expiresAt), 30);
});

test('pasar a Power conserva los días que tenía, ya con Power', async () => {
  await planes.entregar({ userId: 'u1', plan: ESTANDAR }, tx);
  const r = await planes.entregar({ userId: 'u1', plan: POWER }, tx);
  assert.equal(r.nivel, 'POWER');
  assert.equal(r.planCode, 'EPICURO_POWER');
  assert.equal(dias(r.expiresAt), 60);
});

test('reembolso: resta los días; si no queda nada, vence ahora; dos veces no', async () => {
  await planes.entregar({ userId: 'u1', plan: ESTANDAR }, tx);
  await planes.entregar({ userId: 'u1', plan: ESTANDAR }, tx);
  assert.equal(await planes.descontar({ userId: 'u1', dias: 30 }), 'acortada');
  assert.equal(dias(filas.get('u1').expiresAt), 30);
  assert.equal(await planes.descontar({ userId: 'u1', dias: 30 }), 'revocada');
  assert.equal(await planes.descontar({ userId: 'u1', dias: 30 }), 'ya_revocada');
  assert.equal(await planes.descontar({ userId: 'nadie', dias: 30 }), 'ya_revocada');
});

test('Epicuro solo ve un plan vigente, por el correo', async () => {
  usuarios.set('ana@gmail.com', { id: 'u1' });
  assert.equal(await planes.deCorreo('Ana@Gmail.com'), null, 'sin plan');
  await planes.entregar({ userId: 'u1', plan: POWER }, tx);
  const vigente = await planes.deCorreo(' ana@gmail.com ');
  assert.equal(vigente.nivel, 'POWER');
  filas.get('u1').expiresAt = new Date(Date.now() - 1000);
  assert.equal(await planes.deCorreo('ana@gmail.com'), null, 'vencido');
  assert.equal(await planes.deCorreo('nadie@gmail.com'), null);
});

test('un ADMIN sin plan comprado entra a Epicuro con Power, por un día', async () => {
  usuarios.set('jefe@acosta.pe', { id: 'a1', role: 'ADMIN' });
  const plan = await planes.deCorreo('jefe@acosta.pe');
  assert.equal(plan.nivel, 'POWER');
  assert.equal(plan.planCode, 'ADMIN');
  assert.equal(dias(plan.expiresAt), 1);

  await planes.entregar({ userId: 'a1', plan: ESTANDAR }, tx);
  assert.equal((await planes.deCorreo('jefe@acosta.pe')).planCode, 'EPICURO_ESTANDAR', 'si compró, manda lo comprado');

  usuarios.set('pais@acosta.pe', { id: 'p1', role: 'ADMIN_PAIS' });
  assert.equal(await planes.deCorreo('pais@acosta.pe'), null, 'solo el ADMIN');
});
