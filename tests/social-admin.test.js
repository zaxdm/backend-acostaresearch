'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const express = require('express');
const { UnauthorizedError } = require('../src/shared/errors/AppError');

function cargar(archivo, mocks) {
  const filename = path.resolve(__dirname, archivo);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, Date,
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id),
  });
  return module.exports;
}
const ID = '00000000-0000-4000-8000-000000000001';

async function preparar(t, { humano = false, clienteAt = new Date(), activo = true, existentes = [] } = {}) {
  const c = {
    id: ID, clave: 'hash-privado', canal: 'instagram', cuenta: 'ig1', contacto: 'cliente1',
    nombre: 'Javier', humano, noLeidos: 0, revision: 3, historial: [],
    ultimoDelClienteAt: clienteAt, ultimoMensajeAt: new Date(),
  };
  const trabajos = [];
  let lecturas = 0; let autenticaciones = 0; let autorizaciones = 0;
  const update = (data) => {
    for (const [key, value] of Object.entries(data)) c[key] = value && typeof value === 'object' && 'increment' in value ? c[key] + value.increment : value;
    return structuredClone(c);
  };
  const db = {
    socialConversacion: {
      async findUnique({ where }) { lecturas++; return where.id === c.id ? structuredClone(c) : null; },
      async update({ data }) { return update(data); },
      async updateMany({ where, data }) {
        const matches = Object.entries(where).every(([key, value]) => value instanceof Date ? c[key]?.getTime() === value.getTime() : c[key] === value);
        if (!matches) return { count: 0 };
        update(data); return { count: 1 };
      },
      async findMany() { return [{ ...structuredClone(c), trabajos: [] }]; },
    },
    socialTrabajo: {
      async count() { lecturas++; return 0; },
      async create({ data }) { trabajos.push(structuredClone(data)); return data; },
      async findFirst({ where }) {
        return structuredClone(existentes.find((j) => j.id === where.id && j.conversacionId === where.conversacionId && j.autor === where.autor) || null);
      },
      async findMany({ where = {} } = {}) {
        // Las respuestas encoladas por el panel cuentan como PENDIENTE para la regla de «una privada por comentario».
        const todos = [...existentes, ...trabajos.map((j) => ({ estado: 'PENDIENTE', ...j }))];
        if (where.autor) return structuredClone(todos.filter((j) => j.autor === where.autor && (!where.estado?.in || where.estado.in.includes(j.estado))));
        return structuredClone(existentes);
      },
    },
    socialPrueba: { async findUnique() { return null; } },
    async $transaction(fn) { return fn(db); },
  };
  const env = {
    SOCIAL_META_ENABLED: activo, SOCIAL_BOT_ENABLED: true, SOCIAL_BOT_API_KEY: 'secreto-gemini-no-exponer',
    SOCIAL_BOT_TRIAL_PRODUCT: 'HUMANIZADOR', SOCIAL_META_APP_SECRET: 'secreto-meta-no-exponer',
    SOCIAL_META_VERIFY_TOKEN: 'secreto-verificacion-no-exponer', SOCIAL_META_FACEBOOK_PAGE_ID: 'page1',
    SOCIAL_META_INSTAGRAM_ID: 'ig1', SOCIAL_META_PAGE_TOKEN: 'secreto-pagina-no-exponer',
    API_PREFIX: '/api/v1', apiPublicUrl: 'https://api.example.com',
  };
  const realAuthorize = cargar('../src/middlewares/authorize.js', { '../config/env': env });
  const router = cargar('../src/modules/social-bot/social.admin.js', {
    '../../config/env': env, '../../lib/prisma': db,
    '../../middlewares/authenticate': (req, _res, next) => {
      autenticaciones++;
      const role = req.get('x-test-role');
      if (!role) return next(new UnauthorizedError());
      req.user = { id: 'admin1', role, pais: role === 'ADMIN_PAIS' ? 'PE' : null };
      next();
    },
    '../../middlewares/authorize': (...roles) => {
      assert.equal(roles.join(','), 'ADMIN');
      const middleware = realAuthorize(...roles);
      return (req, res, next) => { autorizaciones++; return middleware(req, res, next); };
    },
    './social.service': { hash: (...args) => createHash('sha256').update(JSON.stringify(args)).digest('hex') },
  });
  const app = express(); app.use(express.json()); app.use('/api/v1/social-bot/admin', router);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ success: false, error: { message: error.message } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const request = async (ruta, { role = 'ADMIN', method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/social-bot/admin${ruta}`, {
      method, headers: { ...(role ? { 'x-test-role': role } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, c, trabajos, contadores: () => ({ lecturas, autenticaciones, autorizaciones }) };
}

test('la bandeja exige autenticación y rol ADMIN antes de consultar la base', async (t) => {
  const p = await preparar(t);
  assert.equal((await p.request('/estado', { role: null })).status, 401);
  assert.equal((await p.request('/estado', { role: 'USER' })).status, 403);
  assert.equal((await p.request('/estado', { role: 'ADMIN_PAIS' })).status, 403);
  assert.equal(p.contadores().lecturas, 0);
  assert.equal(p.contadores().autenticaciones, 3);
  assert.equal(p.contadores().autorizaciones, 2);
});

test('el estado devuelve configuración pública sin valores de secretos', async (t) => {
  const p = await preparar(t);
  const r = await p.request('/estado');
  assert.equal(r.status, 200); assert.equal(r.body.data.activo, true);
  assert.equal(r.body.data.canales.find((c) => c.canal === 'instagram').configurado, true);
  assert.equal(r.body.data.canales.find((c) => c.canal === 'whatsapp').configurado, false);
  assert.match(r.body.data.webhookUrl, /\/social-bot\/webhook$/);
  assert.doesNotMatch(JSON.stringify(r.body), /secreto-(gemini|meta|verificacion|pagina)-no-exponer/);
});

test('dos respuestas manuales consecutivas conservan la misma revisión humana y ambas quedan encoladas', async (t) => {
  const p = await preparar(t, { humano: true });
  const ruta = `/conversaciones/${ID}/responder`;
  assert.equal((await p.request(ruta, { method: 'POST', body: { texto: 'Primera respuesta' } })).status, 200);
  assert.equal((await p.request(ruta, { method: 'POST', body: { texto: 'Segunda respuesta' } })).status, 200);
  assert.equal(p.trabajos.length, 2);
  assert.deepEqual(p.trabajos.map((j) => j.revision), [3, 3]);
  assert.notEqual(p.trabajos[0].clave, p.trabajos[1].clave);
  assert.deepEqual(p.trabajos.map((j) => j.texto), ['Primera respuesta', 'Segunda respuesta']);
});

test('la primera respuesta del equipo toma la conversación y las siguientes preservan esa revisión', async (t) => {
  const p = await preparar(t);
  const ruta = `/conversaciones/${ID}/responder`;
  await p.request(ruta, { method: 'POST', body: { texto: 'Hola' } });
  await p.request(ruta, { method: 'POST', body: { texto: '¿En qué te ayudamos?' } });
  assert.equal(p.c.humano, true); assert.equal(p.c.revision, 4);
  assert.deepEqual(p.trabajos.map((j) => j.revision), [4, 4]);
});

test('Instagram valida bytes UTF-8 antes de encolar una respuesta manual', async (t) => {
  const p = await preparar(t);
  const r = await p.request(`/conversaciones/${ID}/responder`, { method: 'POST', body: { texto: 'á'.repeat(501) } });
  assert.equal(r.status, 422); assert.equal(p.trabajos.length, 0); assert.equal(p.c.humano, false);
  assert.equal((await p.request(`/conversaciones/${ID}/responder`, { method: 'POST', body: { texto: 'á'.repeat(500) } })).status, 200);
  assert.equal(p.trabajos.length, 1);
});

test('sin ventana privada el equipo recibe conflicto y no se encola ningún mensaje', async (t) => {
  const p = await preparar(t, { clienteAt: null });
  const r = await p.request(`/conversaciones/${ID}/responder`, { method: 'POST', body: { texto: 'Hola' } });
  assert.equal(r.status, 409); assert.equal(p.trabajos.length, 0);
});

test('cambiar responsable invalida generación y deja el estado solicitado', async (t) => {
  const p = await preparar(t);
  const r = await p.request(`/conversaciones/${ID}/modo`, { method: 'PATCH', body: { humano: true } });
  assert.equal(r.status, 200); assert.equal(p.c.humano, true); assert.equal(p.c.revision, 4);
  assert.equal(p.c.lease, null); assert.equal(p.c.busyUntil, null);
});

test('identificadores inválidos y conversaciones inexistentes no permiten acciones', async (t) => {
  const p = await preparar(t);
  assert.equal((await p.request('/conversaciones/incorrecto/modo', { method: 'PATCH', body: { humano: true } })).status, 422);
  assert.equal((await p.request('/conversaciones/00000000-0000-4000-8000-000000000099/modo', { method: 'PATCH', body: { humano: true } })).status, 404);
});

const COMENTARIO = '00000000-0000-4000-8000-0000000000c1';
function comentario(dias = 1) {
  return {
    id: COMENTARIO, conversacionId: ID, autor: 'CLIENTE', texto: 'Skill', estado: 'HUMANO', createdAt: new Date(), updatedAt: new Date(), error: null,
    evento: { canal: 'instagram', cuenta: 'ig1', contacto: 'cliente1', tipo: 'comentario', comentarioId: 'c-123', texto: 'Skill', timestamp: new Date(Date.now() - dias * 86400000).toISOString() },
  };
}

test('un comentario se responde por privado aunque no haya ventana de 24 horas, y solo una vez', async (t) => {
  const p = await preparar(t, { clienteAt: null, existentes: [comentario()] });
  const ruta = `/conversaciones/${ID}/responder`;
  const r = await p.request(ruta, { method: 'POST', body: { texto: 'Te paso la info', comentario: COMENTARIO, via: 'privado' } });
  assert.equal(r.status, 200);
  assert.equal(p.trabajos[0].evento.tipo, 'respuesta_privada');
  assert.equal(p.trabajos[0].evento.comentarioId, 'c-123');
  // El plazo de 7 días se cuenta desde el comentario, no desde la respuesta.
  assert.ok(Date.now() - new Date(p.trabajos[0].evento.timestamp) > 0.9 * 86400000);
  const otra = await p.request(ruta, { method: 'POST', body: { texto: 'Otra vez', comentario: COMENTARIO, via: 'privado' } });
  assert.equal(otra.status, 409); assert.equal(p.trabajos.length, 1);
  // En público sí se puede responder después.
  const publica = await p.request(ruta, { method: 'POST', body: { texto: '¡Te escribimos al DM!', comentario: COMENTARIO, via: 'publico' } });
  assert.equal(publica.status, 200); assert.equal(p.trabajos[1].evento.tipo, 'comentario'); assert.equal(p.trabajos[1].evento.comentarioId, 'c-123');
});

test('un comentario de hace más de 7 días ya no se puede responder', async (t) => {
  const p = await preparar(t, { clienteAt: null, existentes: [comentario(8)] });
  const r = await p.request(`/conversaciones/${ID}/responder`, { method: 'POST', body: { texto: 'Hola', comentario: COMENTARIO, via: 'privado' } });
  assert.equal(r.status, 409); assert.equal(p.trabajos.length, 0);
});

test('responder a un comentario exige comentario y vía juntos, y que sea de esa conversación', async (t) => {
  const p = await preparar(t, { clienteAt: null, existentes: [comentario()] });
  const ruta = `/conversaciones/${ID}/responder`;
  assert.equal((await p.request(ruta, { method: 'POST', body: { texto: 'Hola', via: 'privado' } })).status, 422);
  assert.equal((await p.request(ruta, { method: 'POST', body: { texto: 'Hola', comentario: COMENTARIO } })).status, 422);
  const ajeno = await p.request(ruta, { method: 'POST', body: { texto: 'Hola', comentario: '00000000-0000-4000-8000-0000000000c9', via: 'publico' } });
  assert.equal(ajeno.status, 404); assert.equal(p.trabajos.length, 0);
});

test('el detalle marca los comentarios y si ya tienen respuesta privada', async (t) => {
  const respondido = { id: '00000000-0000-4000-8000-0000000000a1', conversacionId: ID, autor: 'ADMIN', texto: 'Info', estado: 'ENVIADO', createdAt: new Date(), updatedAt: new Date(), error: null, evento: { tipo: 'respuesta_privada', comentarioId: 'c-123' } };
  const p = await preparar(t, { clienteAt: null, existentes: [respondido, comentario()] });
  const r = await p.request(`/conversaciones/${ID}`);
  assert.equal(r.status, 200);
  const m = r.body.data.mensajes.find((x) => x.id === COMENTARIO);
  assert.deepEqual(m.comentario, { vigente: true, privado: true });
  assert.equal(r.body.data.mensajes.find((x) => x.id === respondido.id).comentario, null);
});

test('responder a mano da al equipo un turno de 2 horas', async (t) => {
  const p = await preparar(t);
  await p.request(`/conversaciones/${ID}/responder`, { method: 'POST', body: { texto: 'Hola' } });
  const resto = new Date(p.c.humanoHasta).getTime() - Date.now();
  assert.ok(resto > 1.9 * 3600000 && resto <= 2 * 3600000);
});

test('devolver al bot borra el turno del equipo y tomarla lo inicia', async (t) => {
  const p = await preparar(t);
  await p.request(`/conversaciones/${ID}/modo`, { method: 'PATCH', body: { humano: true } });
  assert.ok(p.c.humanoHasta instanceof Date);
  await p.request(`/conversaciones/${ID}/modo`, { method: 'PATCH', body: { humano: false } });
  assert.equal(p.c.humanoHasta, null);
});

test('el equipo marca si compró y qué producto, y puede deshacerlo', async (t) => {
  const p = await preparar(t);
  const ruta = `/conversaciones/${ID}/resultado`;
  const r = await p.request(ruta, { method: 'PATCH', body: { resultado: 'COMPRO', producto: 'Humanizador Académico' } });
  assert.equal(r.status, 200); assert.equal(p.c.resultado, 'COMPRO'); assert.equal(p.c.resultadoProducto, 'Humanizador Académico');
  assert.ok(p.c.resultadoAt instanceof Date);
  assert.equal((await p.request(ruta, { method: 'PATCH', body: { resultado: 'COMPRO' } })).status, 422);
  assert.equal((await p.request(ruta, { method: 'PATCH', body: { resultado: 'NO_COMPRO', producto: 'TSP' } })).status, 422);
  assert.equal((await p.request(ruta, { method: 'PATCH', body: { resultado: 'COMPRO', producto: 'Inventado' } })).status, 422);
  await p.request(ruta, { method: 'PATCH', body: { resultado: null } });
  assert.equal(p.c.resultado, null); assert.equal(p.c.resultadoProducto, null); assert.equal(p.c.resultadoAt, null);
});
