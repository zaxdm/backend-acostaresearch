'use strict';

const crypto = require('node:crypto');

// Facebook Login + linked professional Instagram account. These adapters do not
// use graph.instagram.com tokens or the Instagram Login permission family.
// https://developers.facebook.com/docs/messenger-platform/getting-started/quick-start
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages
// https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes
const GRAPH = 'https://graph.facebook.com';
const MAX_TEXT = Object.freeze({ facebook: 2000, instagram: 1000, whatsapp: 4000 });
const WINDOW_MS = 24 * 60 * 60 * 1000;
const lista = (value) => Array.isArray(value) ? value : [];
const cadena = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';

function firmaValida(rawBody, header, secret) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'));
}

function fecha(valor, unidad = 'ms') {
  const numero = Number(valor);
  // Missing/invalid timestamps deliberately do not open the messaging window.
  if (!Number.isFinite(numero) || numero <= 0) return new Date(0).toISOString();
  const date = new Date(unidad === 's' ? numero * 1000 : numero);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function ventanaAbierta(timestamp, ahora = Date.now()) {
  const value = new Date(timestamp).getTime();
  const current = Number(ahora instanceof Date ? ahora.getTime() : ahora);
  return Number.isFinite(value) && value > 0 && value <= current + 60000 && current - value < WINDOW_MS;
}

function textoWhatsapp(mensaje) {
  return cadena(mensaje.text?.body || mensaje.button?.text ||
    mensaje.interactive?.button_reply?.title || mensaje.interactive?.list_reply?.title).trim();
}

function extraerEventos(body, { facebookPageId, instagramAccountId, whatsappPhoneNumberId } = {}) {
  const eventos = [];
  if (body?.object === 'whatsapp_business_account') {
    if (!whatsappPhoneNumberId) return eventos;
    for (const entry of lista(body.entry)) for (const change of lista(entry?.changes)) {
      const value = change?.value;
      if (!value || cadena(value.metadata?.phone_number_id) !== cadena(whatsappPhoneNumberId)) continue;
      const nombres = new Map(lista(value.contacts).map((c) => [cadena(c.wa_id), cadena(c.profile?.name)]));
      const eco = change.field === 'smb_message_echoes';
      if (!eco && change.field !== 'messages') continue;
      for (const message of lista(eco ? value.message_echoes : value.messages)) {
        const contacto = cadena(eco ? message?.to : message?.from);
        if (!/^\d{5,20}$/.test(contacto) || !message.id) continue;
        const prueba = !eco && (message.button?.payload || message.interactive?.button_reply?.id || message.interactive?.list_reply?.id) === 'ACOSTA_PRUEBA';
        eventos.push({
          canal: 'whatsapp', cuenta: cadena(whatsappPhoneNumberId), contacto,
          evento: cadena(message.id), texto: prueba ? 'Quiero probar gratis' : textoWhatsapp(message), nombre: nombres.get(contacto) || '',
          tipo: 'privado', eco, timestamp: fecha(message.timestamp, 's'),
          ...(prueba ? { accion: 'prueba' } : {}),
        });
      }
    }
    return eventos;
  }
  const canal = body?.object === 'page' ? 'facebook' : body?.object === 'instagram' ? 'instagram' : null;
  const propia = canal === 'facebook' ? facebookPageId : instagramAccountId;
  if (!canal || !propia) return eventos;
  for (const entry of lista(body.entry)) {
    if (cadena(entry?.id) !== cadena(propia)) continue;
    for (const messaging of lista(entry.messaging)) {
      const message = messaging?.message;
      const postback = messaging?.postback;
      if (!message && !postback) continue; // delivery, read, reactions, opt-ins
      const eco = message?.is_echo === true;
      const sender = cadena(messaging.sender?.id);
      const recipient = cadena(messaging.recipient?.id);
      if ((!eco && recipient !== cadena(propia)) || (eco && sender !== cadena(propia))) continue;
      const contacto = eco ? recipient : sender;
      if (!contacto || contacto === cadena(propia)) continue;
      // Modern postbacks have mid; older ones have a stable timestamp/payload.
      const id = cadena(message?.mid || postback?.mid) || (postback && messaging.timestamp
        ? `postback-${crypto.createHash('sha256').update(JSON.stringify([propia, contacto, messaging.timestamp, postback.payload])).digest('hex')}` : '');
      if (!id) continue;
      const prueba = !eco && (postback?.payload || message?.quick_reply?.payload) === 'ACOSTA_PRUEBA';
      eventos.push({
        canal, cuenta: cadena(propia), contacto, evento: id,
        texto: prueba ? 'Quiero probar gratis' : cadena(message?.text || postback?.title || postback?.payload).trim(), nombre: '',
        tipo: 'privado', eco, timestamp: fecha(messaging.timestamp),
        ...(message?.app_id ? { appId: cadena(message.app_id) } : {}),
        ...(prueba ? { accion: 'prueba' } : {}),
      });
    }
    for (const change of lista(entry.changes)) {
      const value = change?.value;
      if (!value) continue;
      if (canal === 'facebook') {
        if (change.field !== 'feed' || value.item !== 'comment' || value.verb !== 'add') continue;
        const contacto = cadena(value.from?.id || value.sender_id);
        const comment = cadena(value.comment_id);
        if (!contacto || contacto === cadena(propia) || !comment) continue;
        eventos.push({
          canal, cuenta: cadena(propia), contacto, evento: `comment-${comment}`,
          comentarioId: comment, texto: cadena(value.message).trim(), nombre: cadena(value.from?.name),
          ...(value.post_id ? { postId: cadena(value.post_id) } : {}),
          tipo: 'comentario', eco: false, timestamp: fecha(value.created_time || entry.time, 's'),
        });
      } else {
        if (change.field !== 'comments') continue; // Live comments require separate handling.
        const contacto = cadena(value.from?.id);
        const comment = cadena(value.id);
        if (!contacto || contacto === cadena(propia) || !comment) continue;
        eventos.push({
          canal, cuenta: cadena(propia), contacto, evento: `comment-${comment}`,
          comentarioId: comment, texto: cadena(value.text).trim(), nombre: cadena(value.from?.username),
          tipo: 'comentario', eco: false, timestamp: fecha(entry.time, 's'),
        });
      }
    }
  }
  return eventos;
}

class MetaError extends Error {
  constructor(message, { permanente = false, ambiguo = false, status = null, code = null } = {}) {
    super(message);
    this.name = 'MetaError';
    this.permanente = permanente;
    this.ambiguo = ambiguo;
    this.status = status;
    this.code = code;
  }
}

function comprobarTexto(canal, texto) {
  const maximo = MAX_TEXT[canal];
  if (!maximo || typeof texto !== 'string' || !texto.trim()) throw new MetaError('El mensaje está vacío o el canal no es válido.', { permanente: true });
  // Conservative UTF-8 byte limit on Instagram; do not split multi-byte text.
  const longitud = canal === 'instagram' ? Buffer.byteLength(texto, 'utf8') : texto.length;
  if (longitud > maximo) throw new MetaError(`El texto supera el límite de ${maximo} del canal.`, { permanente: true });
}

async function enviar(evento, texto, { token, version = 'v25.0', facebookPageId, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  comprobarTexto(evento?.canal, texto);
  if (!token || !/^v\d+\.\d+$/.test(version)) throw new MetaError('Falta configurar el token o la versión de Meta.', { permanente: true });
  const segmento = (id) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_:.-]{1,150}$/.test(id)) throw new MetaError('El identificador del destinatario no es válido.', { permanente: true });
    return encodeURIComponent(id);
  };
  let endpoint; let payload;
  if (evento.tipo === 'comentario') {
    if (evento.canal === 'whatsapp') throw new MetaError('WhatsApp no admite comentarios.', { permanente: true });
    endpoint = `${segmento(evento.comentarioId)}/${evento.canal === 'instagram' ? 'replies' : 'comments'}`;
    payload = { message: texto };
  } else if (evento.tipo === 'respuesta_privada') {
    // Respuesta privada de Meta: un mensaje directo dirigido al comentario, no al usuario.
    if (evento.canal === 'whatsapp') throw new MetaError('WhatsApp no admite comentarios.', { permanente: true });
    endpoint = `${segmento(evento.canal === 'instagram' ? facebookPageId : evento.cuenta)}/messages`;
    payload = { recipient: { comment_id: evento.comentarioId }, message: { text: texto } };
    segmento(evento.comentarioId);
  } else if (evento.canal === 'whatsapp') {
    endpoint = `${segmento(evento.cuenta)}/messages`;
    payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: evento.contacto, type: 'text', text: { preview_url: true, body: texto } };
    segmento(evento.contacto);
  } else {
    const cuenta = evento.canal === 'instagram' ? facebookPageId : evento.cuenta;
    endpoint = `${segmento(cuenta)}/messages`;
    payload = {
      recipient: { id: evento.contacto }, message: { text: texto },
      ...(evento.canal === 'facebook' ? { messaging_type: 'RESPONSE' } : {}),
    };
    segmento(evento.contacto);
  }
  let response; let body;
  try {
    response = await fetchImpl(`${GRAPH}/${version}/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.json().catch(() => null);
  } catch {
    // A timeout can occur after Meta accepted the POST. A blind retry can send
    // it twice, so the worker must leave this for a human to reconcile.
    throw new MetaError('No se pudo confirmar el envío a Meta.', { ambiguo: true });
  }
  if (!response.ok || body?.error) {
    const code = Number(body?.error?.code) || null;
    const ambiguo = response.status >= 500;
    const transitorio = response.status === 429 || body?.error?.is_transient === true || [1, 2, 4, 17, 32, 613].includes(code);
    throw new MetaError(`Meta rechazó el envío (HTTP ${response.status}${code ? `, código ${code}` : ''}).`, {
      status: response.status, code, ambiguo, permanente: !ambiguo && !transitorio,
    });
  }
  const id = cadena(body?.messages?.[0]?.id || body?.message_id || body?.id);
  if (!id) throw new MetaError('Meta respondió sin identificador de envío.', { ambiguo: true, status: response.status });
  return id;
}

/**
 * El texto de la publicación donde se comentó, para que el bot sepa de qué producto hablar
 * («Comenta SKILL…» en el reel de Turnitin = Humanizador). Si falla, devuelve '' y el bot
 * responde sin ese contexto: nunca bloquea la respuesta.
 */
async function publicacion(evento, { token, version = 'v25.0', fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const instagram = evento?.canal === 'instagram';
  const id = instagram ? evento?.comentarioId : evento?.postId;
  if (!token || typeof id !== 'string' || !/^[a-zA-Z0-9_]{1,150}$/.test(id) || !/^v\d+\.\d+$/.test(version)) return '';
  const campos = instagram ? 'media{caption}' : 'message';
  try {
    const response = await fetchImpl(`${GRAPH}/${version}/${encodeURIComponent(id)}?fields=${encodeURIComponent(campos)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return '';
    const body = await response.json();
    return cadena(instagram ? body?.media?.caption : body?.message).slice(0, 1500);
  } catch {
    return '';
  }
}

module.exports = { firmaValida, extraerEventos, enviar, publicacion, MetaError, MAX_TEXT, ventanaAbierta };
