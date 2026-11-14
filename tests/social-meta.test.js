'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { firmaValida, extraerEventos, enviar, MetaError, ventanaAbierta, publicacion } = require('../src/modules/social-bot/social.meta');

const config = { facebookPageId: '111', instagramAccountId: '222', whatsappPhoneNumberId: '333' };
const tiempo = 1794680000000;
const fb = (messaging, changes = [], id = '111') => ({ object: 'page', entry: [{ id, time: tiempo / 1000, messaging, changes }] });
const dm = (extra = {}) => ({ sender: { id: '999' }, recipient: { id: '111' }, timestamp: tiempo, message: { mid: 'm1', text: 'Hola' }, ...extra });
const wa = (field, value, phone = '333') => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field, value: { metadata: { phone_number_id: phone }, ...value } }] }] });
const ok = (body = { message_id: 'salida-1' }) => ({ ok: true, status: 200, json: async () => body });

test('la firma comprueba el cuerpo exacto y rechaza formatos inválidos y ausencia de secreto', () => {
  const raw = Buffer.from('{"hola":1}');
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(raw).digest('hex')}`;
  assert.equal(firmaValida(raw, signature, 'secret'), true);
  assert.equal(firmaValida(Buffer.from('{}'), signature, 'secret'), false);
  assert.equal(firmaValida(raw, `${signature}=extra`, 'secret'), false);
  assert.equal(firmaValida(raw, signature, undefined), false);
  assert.equal(firmaValida('{}', signature, 'secret'), false);
});

test('extrae Messenger solo de la página y destinatario autorizados', () => {
  const [e] = extraerEventos(fb([dm()]), config);
  assert.equal(e.canal, 'facebook'); assert.equal(e.cuenta, '111'); assert.equal(e.contacto, '999');
  assert.equal(e.timestamp, new Date(tiempo).toISOString()); assert.equal(e.eco, false);
  assert.deepEqual(extraerEventos(fb([dm()]), {}), []);
  assert.deepEqual(extraerEventos(fb([dm()], [], 'otra'), config), []);
  assert.deepEqual(extraerEventos(fb([dm({ recipient: { id: 'otra' } })]), config), []);
});

test('ecos de Messenger conservan el contacto y la app para detener al bot sin bucles', () => {
  const [e] = extraerEventos(fb([dm({ sender: { id: '111' }, recipient: { id: '999' }, message: { mid: 'eco', text: 'Te atiendo', is_echo: true, app_id: 'app1' } })]), config);
  assert.equal(e.contacto, '999'); assert.equal(e.eco, true); assert.equal(e.appId, 'app1');
});

test('ignora avisos de leído, entregado y objetos malformados sin lanzar', () => {
  assert.deepEqual(extraerEventos(fb([{ read: {} }, { delivery: {} }]), config), []);
  assert.deepEqual(extraerEventos({ object: 'page', entry: {} }, config), []);
  assert.deepEqual(extraerEventos(null, config), []);
});

test('postback de prueba es explícito y genera un identificador repetible', () => {
  const body = fb([dm({ message: undefined, postback: { payload: 'ACOSTA_PRUEBA', title: 'Probar gratis' } })]);
  const [a] = extraerEventos(body, config); const [b] = extraerEventos(body, config);
  assert.equal(a.accion, 'prueba'); assert.equal(a.texto, 'Quiero probar gratis'); assert.equal(a.evento, b.evento);
  assert.equal(extraerEventos(fb([dm()]), config)[0].accion, undefined);
});

test('extrae únicamente comentarios añadidos por otras personas en Facebook', () => {
  const change = { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: '111_444', from: { id: '999', name: 'Javier' }, message: 'Skill', created_time: tiempo / 1000 } };
  const [e] = extraerEventos(fb([], [change]), config);
  assert.equal(e.comentarioId, '111_444'); assert.equal(e.tipo, 'comentario'); assert.equal(e.nombre, 'Javier');
  assert.deepEqual(extraerEventos(fb([], [{ ...change, value: { ...change.value, verb: 'edited' } }]), config), []);
  assert.deepEqual(extraerEventos(fb([], [{ ...change, value: { ...change.value, from: { id: '111' } } }]), config), []);
});

test('Instagram valida la cuenta y extrae DM, comentario y eco', () => {
  const body = { object: 'instagram', entry: [{ id: '222', time: tiempo / 1000,
    messaging: [dm({ recipient: { id: '222' } })],
    changes: [{ field: 'comments', value: { id: '456', from: { id: '999', username: 'javier' }, text: 'Skill' } }],
  }] };
  const eventos = extraerEventos(body, config);
  assert.equal(eventos.length, 2); assert.equal(eventos[0].canal, 'instagram'); assert.equal(eventos[1].comentarioId, '456');
  assert.deepEqual(extraerEventos(body, { ...config, instagramAccountId: undefined }), []);
});

test('WhatsApp extrae texto y botón de prueba sin aceptar otro número', () => {
  const body = wa('messages', { contacts: [{ wa_id: '51999999999', profile: { name: 'Ana' } }], messages: [
    { id: 'wa1', from: '51999999999', timestamp: String(tiempo / 1000), type: 'text', text: { body: 'Hola' } },
    { id: 'wa2', from: '51999999999', timestamp: String(tiempo / 1000), type: 'interactive', interactive: { button_reply: { id: 'ACOSTA_PRUEBA', title: 'Probar' } } },
  ] });
  const [a, b] = extraerEventos(body, config);
  assert.equal(a.nombre, 'Ana'); assert.equal(a.canal, 'whatsapp'); assert.equal(b.accion, 'prueba');
  assert.deepEqual(extraerEventos(body, {}), []);
  assert.deepEqual(extraerEventos(body, { ...config, whatsappPhoneNumberId: 'otra' }), []);
});

test('el eco de WhatsApp corresponde al destinatario y no entra como mensaje nuevo', () => {
  const [e] = extraerEventos(wa('smb_message_echoes', { message_echoes: [{ id: 'eco1', to: '51999999999', timestamp: '1794680000', type: 'text', text: { body: 'Te atiendo' } }] }), config);
  assert.equal(e.eco, true); assert.equal(e.contacto, '51999999999'); assert.equal(e.texto, 'Te atiendo');
  assert.deepEqual(extraerEventos(wa('messages', { statuses: [{ id: 'wa1' }] }), config), []);
});

test('la ventana usa el evento original y no abre acceso con fecha inválida o futura', () => {
  assert.equal(ventanaAbierta(new Date(tiempo - 1000).toISOString(), tiempo), true);
  assert.equal(ventanaAbierta(new Date(tiempo - 86400000).toISOString(), tiempo), false);
  assert.equal(ventanaAbierta('fecha inválida', tiempo), false);
  assert.equal(ventanaAbierta(new Date(tiempo + 86400000).toISOString(), tiempo), false);
});

test('envío Messenger usa token en cabecera, sin secreto en URL y devuelve id', async () => {
  let url; let options;
  const id = await enviar({ canal: 'facebook', cuenta: '111', contacto: '999', tipo: 'privado' }, 'Hola', { token: 'SECRETO', fetchImpl: async (u, o) => { url = u; options = o; return ok(); } });
  assert.equal(id, 'salida-1'); assert.equal(url, 'https://graph.facebook.com/v25.0/111/messages');
  assert.equal(options.headers.Authorization, 'Bearer SECRETO'); assert.equal(url.includes('SECRETO'), false);
  assert.deepEqual(JSON.parse(options.body).recipient, { id: '999' });
});

test('Instagram Facebook Login envía DM mediante la página y respuestas por replies', async () => {
  const urls = []; const bodies = [];
  const opts = { token: 'test', facebookPageId: '111', fetchImpl: async (url, options) => { urls.push(url); bodies.push(JSON.parse(options.body)); return ok({ id: 'salida' }); } };
  await enviar({ canal: 'instagram', cuenta: '222', contacto: '999', tipo: 'privado' }, 'Hola', opts);
  await enviar({ canal: 'instagram', cuenta: '222', contacto: '999', tipo: 'comentario', comentarioId: '456' }, 'Hola', opts);
  assert.equal(urls[0], 'https://graph.facebook.com/v25.0/111/messages');
  assert.equal(urls[1], 'https://graph.facebook.com/v25.0/456/replies');
  assert.deepEqual(bodies[0], { recipient: { id: '999' }, message: { text: 'Hola' } });
  assert.deepEqual(bodies[1], { message: 'Hola' });
});

test('Facebook comenta por comments y WhatsApp manda por el número de negocio', async () => {
  const calls = []; const opts = { token: 'test', fetchImpl: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return ok({ messages: [{ id: 'wa1' }] }); } };
  await enviar({ canal: 'facebook', cuenta: '111', contacto: '999', tipo: 'comentario', comentarioId: '111_456' }, 'Hola', opts);
  await enviar({ canal: 'whatsapp', cuenta: '333', contacto: '51999999999', tipo: 'privado' }, 'Hola', opts);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v25.0/111_456/comments');
  assert.equal(calls[1].body.messaging_product, 'whatsapp'); assert.equal(calls[1].body.to, '51999999999');
});

test('rechaza mensajes largos, sin token o identificadores inyectados antes de enviar', async () => {
  let llamadas = 0; const opts = { token: 'test', facebookPageId: '111', fetchImpl: async () => { llamadas++; return ok(); } };
  const e = { canal: 'instagram', cuenta: '222', contacto: '999', tipo: 'privado' };
  await assert.rejects(enviar(e, 'á'.repeat(501), opts), (error) => error.permanente);
  await assert.rejects(enviar({ ...e, contacto: '../messages?token=otro' }, 'Hola', opts), (error) => error.permanente);
  await assert.rejects(enviar(e, 'Hola', { ...opts, token: undefined }), (error) => error.permanente);
  assert.equal(llamadas, 0);
});

test('red, timeout, 5xx o éxito sin id son ambiguos y no autorizan reenvío automático', async () => {
  const e = { canal: 'facebook', cuenta: '111', contacto: '999', tipo: 'privado' };
  for (const fetchImpl of [async () => { throw new Error('network'); }, async () => ({ ok: false, status: 503, json: async () => ({ error: {} }) }), async () => ok({})]) {
    await assert.rejects(enviar(e, 'Hola', { token: 'test', fetchImpl }), (error) => error instanceof MetaError && error.ambiguo && !error.permanente);
  }
});

test('429 es reintentable y token inválido es permanente sin exponer mensaje de Meta', async () => {
  const e = { canal: 'facebook', cuenta: '111', contacto: '999', tipo: 'privado' };
  await assert.rejects(enviar(e, 'Hola', { token: 'test', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 4 } }) }) }), (error) => !error.ambiguo && !error.permanente);
  await assert.rejects(enviar(e, 'Hola', { token: 'test', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190, message: 'SECRETO' } }) }) }), (error) => error.permanente && !error.message.includes('SECRETO'));
});

test('la respuesta privada a un comentario va a la página con recipient.comment_id', async () => {
  const calls = [];
  const opts = { token: 'test', facebookPageId: '111', fetchImpl: async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return ok({ message_id: 'm1' }); } };
  await enviar({ canal: 'instagram', cuenta: '222', contacto: '999', tipo: 'respuesta_privada', comentarioId: '456' }, 'Info', opts);
  await enviar({ canal: 'facebook', cuenta: '111', contacto: '999', tipo: 'respuesta_privada', comentarioId: '111_456' }, 'Info', opts);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v25.0/111/messages');
  assert.deepEqual(calls[0].body, { recipient: { comment_id: '456' }, message: { text: 'Info' } });
  assert.equal(calls[1].url, 'https://graph.facebook.com/v25.0/111/messages');
  assert.deepEqual(calls[1].body.recipient, { comment_id: '111_456' });
  await assert.rejects(() => enviar({ canal: 'instagram', cuenta: '222', contacto: '999', tipo: 'respuesta_privada', comentarioId: '../x' }, 'Info', opts));
});

test('lee el texto del post del comentario y nunca bloquea si falla', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return ok({ media: { caption: 'Comenta SKILL' }, message: 'Post de Facebook' }); };
  assert.equal(await publicacion({ canal: 'instagram', comentarioId: '456' }, { token: 't', fetchImpl }), 'Comenta SKILL');
  assert.equal(await publicacion({ canal: 'facebook', postId: '111_222' }, { token: 't', fetchImpl }), 'Post de Facebook');
  assert.match(urls[0], /\/456\?fields=media%7Bcaption%7D$/); assert.match(urls[1], /\/111_222\?fields=message$/);
  assert.equal(await publicacion({ canal: 'instagram', comentarioId: '456' }, { token: 't', fetchImpl: async () => { throw new Error('red'); } }), '');
  assert.equal(await publicacion({ canal: 'facebook' }, { token: 't', fetchImpl }), '');
  assert.equal(await publicacion({ canal: 'instagram', comentarioId: '../x' }, { token: 't', fetchImpl }), '');
});
