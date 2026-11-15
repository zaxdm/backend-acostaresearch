'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const file = path.resolve(__dirname, '../src/modules/social-bot/social.push.js');
const modulePush = { exports: {} };
const localRequire = createRequire(file);
vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
  module: modulePush, exports: modulePush.exports, process, Date,
  require: (id) => {
    if (id === '../../lib/prisma') return {};
    if (id === '../../config/logger') return { warn() {} };
    return localRequire(id);
  },
});
const { crearPush } = modulePush.exports;
const now = new Date('2026-11-14T20:00:00Z');
function setup({ authorized = true, failure, active = true, age = 0 } = {}) {
  const avisos = [{ clave: 'event1', conversacionId: 'c1', canal: 'instagram',
    intentos: 0, createdAt: new Date(now - age), proximoAt: now }];
  const devices = [{ tokenHash: 'hash1', token: 'token1', userId: 'admin1', familyId: 'family1', sessionVersion: 2 }];
  const sent = [], conditions = [], enqueued = [];
  const db = {
    socialAviso: {
      async create({ data }) { enqueued.push(data); },
      async findMany() { return avisos.filter((a) => a.proximoAt <= now); },
      async deleteMany({ where }) { const i = avisos.findIndex((a) => a.clave === where.clave); if (i >= 0) avisos.splice(i, 1); },
      async update({ data }) { avisos[0].intentos++; avisos[0].proximoAt = data.proximoAt; },
    },
    socialDispositivo: {
      async findMany() { return [...devices]; },
      async deleteMany() { devices.length = 0; },
    },
    refreshToken: { async findFirst({ where }) { conditions.push(where); return authorized ? { id: 'session1' } : null; } },
  };
  const push = crearPush({ db, activo: () => active, ahora: () => now,
    enviar: async (token, aviso) => { sent.push({ token, id: aviso.conversacionId }); if (failure) throw failure; } });
  return { push, db, avisos, devices, sent, conditions, enqueued };
}

test('el envío exige familia vigente, mismo usuario, versión y rol ADMIN activo', async () => {
  const s = setup(); await s.push.pasar();
  assert.equal(s.sent.length, 1);
  assert.equal(s.conditions[0].familyId, 'family1');
  assert.equal(s.conditions[0].userId, 'admin1');
  assert.equal(s.conditions[0].revokedAt, null);
  assert.equal(s.conditions[0].sessionVersion, 2);
  assert.equal(s.conditions[0].user.role, 'ADMIN');
  assert.equal(s.conditions[0].user.status, 'ACTIVE');
  assert.equal(s.conditions[0].expiresAt.gt, now);
  assert.equal(s.avisos.length, 0);
});

test('una sesión cerrada, caducada o sin permisos no recibe avisos y elimina su dispositivo', async () => {
  const s = setup({ authorized: false }); await s.push.pasar();
  assert.equal(s.sent.length, 0); assert.equal(s.devices.length, 0);
});

test('un token FCM dado de baja se elimina sin reintento', async () => {
  const s = setup({ failure: { tokenInvalido: true } }); await s.push.pasar();
  assert.equal(s.devices.length, 0); assert.equal(s.avisos.length, 0);
});

test('un fallo temporal conserva el dispositivo y programa reintento persistente', async () => {
  const s = setup({ failure: new Error('timeout') }); await s.push.pasar();
  assert.equal(s.devices.length, 1); assert.equal(s.avisos.length, 1);
  assert.equal(s.avisos[0].intentos, 1);
  assert.ok(s.avisos[0].proximoAt > now);
});

test('Firebase sin configurar no consulta las tablas ni envía avisos', async () => {
  const s = setup({ active: false }); await s.push.pasar();
  await s.push.encolar(s.db, { id: 'c1', canal: 'instagram' }, { eco: false }, 'new');
  assert.equal(s.sent.length, 0); assert.equal(s.conditions.length, 0); assert.equal(s.enqueued.length, 0);
});

test('los ecos del equipo no generan avisos; mensajes entrantes se encolan en la transacción recibida', async () => {
  const s = setup();
  await s.push.encolar(s.db, { id: 'c1', canal: 'instagram' }, { eco: true }, 'echo');
  await s.push.encolar(s.db, { id: 'c1', canal: 'instagram' }, { eco: false }, 'new');
  assert.equal(s.enqueued.length, 1); assert.equal(s.enqueued[0].clave, 'new');
  assert.equal(s.enqueued[0].conversacionId, 'c1');
});

test('un aviso antiguo se descarta sin notificar', async () => {
  const s = setup({ age: 3600001 }); await s.push.pasar();
  assert.equal(s.sent.length, 0); assert.equal(s.avisos.length, 0);
});
