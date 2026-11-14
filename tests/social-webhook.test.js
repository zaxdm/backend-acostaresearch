'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const express = require('express');

const SECRET = 'secreto-de-app-solo-para-test';
const RAW = '{"object":"instagram","entry":[]}';
const firma = (raw = RAW) => `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;

async function preparar(t, { persistir = async () => {}, enabled = true } = {}) {
  let persistencias = 0;
  const filename = path.resolve(__dirname, '../src/modules/social-bot/social.webhook.js');
  const localRequire = createRequire(filename); const module = { exports: {} };
  const mocks = {
    '../../config/env': { SOCIAL_META_ENABLED: enabled, SOCIAL_META_APP_SECRET: SECRET, SOCIAL_META_VERIFY_TOKEN: 'verify-del-test' },
    './social.runtime': { async recibir(body) { persistencias++; return persistir(body); } },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: (id) => mocks[id] || localRequire(id) });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
  app.use('/webhook', module.exports);
  app.use((error, _req, res, _next) => res.status(503).json({ success: false }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const request = (body = RAW, signature = firma()) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body,
  });
  return { request, url, persistencias: () => persistencias };
}

test('la verificación devuelve el reto solo con token correcto', async (t) => {
  const p = await preparar(t);
  assert.equal((await fetch(`${p.url}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123`)).status, 403);
  const r = await fetch(`${p.url}?hub.mode=subscribe&hub.verify_token=verify-del-test&hub.challenge=123`);
  assert.equal(r.status, 200); assert.equal(await r.text(), '123');
});

test('firma inválida o bytes modificados no llegan a persistencia', async (t) => {
  const p = await preparar(t);
  assert.equal((await p.request(RAW, 'sha256=incorrecto')).status, 401);
  assert.equal((await p.request(`${RAW} `, firma())).status, 401);
  assert.equal(p.persistencias(), 0);
});

test('un webhook válido solo confirma después de terminar la persistencia', async (t) => {
  let resolver; let empezo;
  const iniciado = new Promise((r) => { empezo = r; });
  const p = await preparar(t, { persistir: async () => { empezo(); return new Promise((r) => { resolver = r; }); } });
  let recibido = false;
  const promesa = p.request().then((r) => { recibido = true; return r; });
  await iniciado;
  await new Promise((r) => setImmediate(r));
  assert.equal(recibido, false);
  resolver();
  assert.equal((await promesa).status, 200); assert.equal(p.persistencias(), 1);
});

test('un fallo al persistir no confirma 200 y permite reintento de Meta', async (t) => {
  const p = await preparar(t, { persistir: async () => { throw new Error('BD no disponible'); } });
  assert.equal((await p.request()).status, 503); assert.equal(p.persistencias(), 1);
});

test('la conexión apagada no acepta ni guarda nuevos avisos', async (t) => {
  const p = await preparar(t, { enabled: false });
  assert.equal((await p.request()).status, 503); assert.equal(p.persistencias(), 0);
});
