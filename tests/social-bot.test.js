'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { mensaje, solicitaPrueba } = require('../src/modules/social-bot/social.schema');
const { limpiarTexto } = require('../src/modules/social-bot/social.text');
const { sistema } = require('../src/modules/social-bot/social.prompt');
const { autorizado } = require('../src/modules/social-bot/social.auth');

test('no acepta solicitudes sin secreto, con secreto incorrecto ni en otro formato', () => {
  assert.equal(autorizado('Bearer correcto', 'correcto'), true);
  assert.equal(autorizado('Bearer incorrecto', 'correcto'), false);
  assert.equal(autorizado(undefined, 'correcto'), false);
  assert.equal(autorizado('Bearer correcto', undefined), false);
  assert.equal(autorizado('correcto', 'correcto'), false);
});

function preparar({ generar, enabled = true } = {}) {
  let c; const eventos = new Map(); const pruebas = new Map(); const enlaces = [];
  const db = {
    socialConversacion: {
      async upsert({ create }) { c ??= { id: 'c1', humano: false, lease: null, busyUntil: null, ...create }; return { ...c }; },
      async findUnique() { return { ...c }; },
      async updateMany({ where, data }) {
        if (where.lease && where.lease !== c.lease) return { count: 0 };
        if (where.humano === false && c.humano) return { count: 0 };
        if (where.OR && c.busyUntil && c.busyUntil >= new Date()) return { count: 0 };
        Object.assign(c, data); return { count: 1 };
      },
      async update({ data }) { Object.assign(c, data); return c; },
    },
    socialEvento: {
      async findUnique({ where }) { return eventos.get(where.clave); },
      async create({ data }) { eventos.set(data.clave, data); return data; },
    },
    socialPrueba: {
      async findUnique({ where }) { return pruebas.get(where.contacto); },
      async create({ data }) { pruebas.set(data.contacto, data); return data; },
    },
    trialLink: { async create({ data }) { const e = { ...data, createdAt: new Date() }; enlaces.push(e); return e; } },
    async $transaction(fn) { return fn(db); },
  };
  const env = { SOCIAL_BOT_ENABLED: enabled, SOCIAL_BOT_TRIAL_PRODUCT: 'HUMANIZADOR', SOCIAL_BOT_API_KEY: 'test', SOCIAL_BOT_MAX_DIARIO: 5, APP_URL: 'https://example.com' };
  let llamadas = 0;
  const mocks = {
    '../../config/env': env, '../../lib/prisma': db,
    '../../lib/gemini': { generarConRespaldo: async () => { llamadas++; return generar ? generar() : { texto: 'Hola, ¿en qué puedo ayudarte?' }; } },
    '../licensing/license.service': { contratoDelProducto: async () => ({ planId: 'p1' }) },
    '../asistente/asistente.service': { preciosVigentes: async () => ({ planes: [] }) },
  };
  const filename = path.resolve(__dirname, '../src/modules/social-bot/social.service.js');
  const localRequire = require('node:module').createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: (id) => mocks[id] ?? localRequire(id), Date });
  return { service: module.exports, pruebas, enlaces, llamadas: () => llamadas, c: () => c };
}
const base = { canal: 'instagram', cuenta: 'acosta', contacto: '123', evento: 'e1', texto: 'Hola', tipo: 'privado', accion: 'responder' };

test('rechaza duraciones, productos y campos que el cliente no puede elegir', () => {
  assert.equal(mensaje.safeParse({ ...base, accessMinutes: 0 }).success, false);
  assert.equal(mensaje.safeParse({ ...base, productCode: 'TESIS' }).success, false);
  assert.equal(mensaje.safeParse({ ...base, canal: 'otro' }).success, false);
});
test('el catálogo y el texto no autorizan a emitir pruebas ni prometer porcentajes', () => {
  const texto = sistema({ planes: [], appUrl: 'https://example.com' });
  assert.match(texto, /No garantices porcentajes/);
  assert.match(texto, /Nunca afirmes haber creado/);
});
test('preguntar por pruebas o rechazarlas no equivale a pedir su activación', () => {
  for (const t of ['No quiero una prueba', '¿Cuánto dura la prueba?', 'Quiero saber cómo funciona la prueba', 'Quiero información sobre la prueba']) assert.equal(solicitaPrueba(t), false, t);
  for (const t of ['Quiero probar gratis', 'Quisiera una prueba gratuita', 'Prueba gratis', 'Sí, quiero probar']) assert.equal(solicitaPrueba(t), true, t);
});
test('el modelo no puede inventar enlaces de prueba ni dirigir compras a otra web', () => {
  assert.equal(limpiarTexto('Paga https://malicioso.example/planes', 'https://acosta.example').humano, true);
  assert.equal(limpiarTexto('Ya creé https://acosta.example/prueba/inventada', 'https://acosta.example').humano, true);
  assert.equal(limpiarTexto('Compra https://acosta.example/planes', 'https://acosta.example').humano, false);
});
test('reintentar un evento devuelve la misma respuesta sin volver a llamar a IA', async () => {
  const p = preparar(); const a = await p.service.atender(base); const b = await p.service.atender(base);
  assert.equal(a.texto, b.texto); assert.equal(p.llamadas(), 1);
});
test('la prueba requiere solicitud explícita y se entrega una sola vez por contacto', async () => {
  const p = preparar();
  await assert.rejects(p.service.atender({ ...base, accion: 'prueba' }), /solicitar/);
  const d = { ...base, accion: 'prueba', texto: 'Quiero probar gratis' };
  const a = await p.service.atender(d);
  const b = await p.service.atender({ ...d, evento: 'e2' });
  assert.equal(a.pruebaUrl, b.pruebaUrl); assert.equal(p.enlaces.length, 1);
  assert.equal(p.enlaces[0].seats, 1); assert.equal(p.enlaces[0].accessMinutes, 20);
  assert.equal(p.enlaces[0].callsPerDay, 5);
});
test('una prueba vencida no genera un enlace nuevo', async () => {
  const p = preparar(); const d = { ...base, accion: 'prueba', texto: 'Prueba gratis' };
  await p.service.atender(d);
  for (const prueba of p.pruebas.values()) prueba.expiresAt = new Date(0);
  const b = await p.service.atender({ ...d, evento: 'e2' });
  assert.equal(b.estado, 'prueba_utilizada'); assert.equal(b.pruebaUrl, ''); assert.equal(p.enlaces.length, 1);
});
test('los comentarios públicos no emiten pruebas ni consultan IA', async () => {
  const p = preparar(); const r = await p.service.atender({ ...base, tipo: 'comentario', accion: 'prueba', texto: 'Prueba' });
  assert.equal(r.estado, 'comentario'); assert.equal(p.enlaces.length, 0); assert.equal(p.llamadas(), 0);
});
test('la atención humana pausa el bot y se puede devolver', async () => {
  const p = preparar(); await p.service.modo({ ...base, humano: true });
  assert.equal((await p.service.atender(base)).estado, 'persona'); assert.equal(p.llamadas(), 0);
  await p.service.modo({ ...base, humano: false });
  assert.equal((await p.service.atender(base)).estado, 'respondido');
});
test('una intervención humana mientras piensa descarta la respuesta tardía', async () => {
  let p; p = preparar({ generar: async () => { await p.service.modo({ ...base, humano: true }); return { texto: 'No debe salir' }; } });
  const r = await p.service.atender(base);
  assert.equal(r.estado, 'interrumpido'); assert.equal(r.texto, ''); assert.equal(p.c().humano, true);
});
test('apagado no crea conversaciones, pruebas ni llamadas a IA', async () => {
  const p = preparar({ enabled: false }); assert.equal((await p.service.atender(base)).estado, 'apagado');
  assert.equal(p.c(), undefined); assert.equal(p.llamadas(), 0);
});

test('dos mensajes simultáneos no piensan ni crean pruebas a la vez', async () => {
  let resolver; let inicio;
  const iniciado = new Promise((r) => { inicio = r; });
  const p = preparar({ generar: () => { inicio(); return new Promise((r) => { resolver = r; }); } });
  const primera = p.service.atender(base);
  await iniciado;
  await assert.rejects(p.service.atender({ ...base, evento: 'e2' }), /ocupada/);
  resolver({ texto: 'Respuesta' });
  await primera;
  assert.equal(p.llamadas(), 1);
});
