'use strict';
const { Router } = require('express');
const { z } = require('zod');
const { randomUUID } = require('node:crypto');
const env = require('../../config/env');
const db = require('../../lib/prisma');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const { ROLES } = require('../../config/constants');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { NotFoundError, ConflictError, ValidationError } = require('../../shared/errors/AppError');
const { hash } = require('./social.service');
const { ventana } = require('./social.worker');
const params = z.object({ id: z.string().uuid() });
const router = Router();
router.use(authenticate, authorize(ROLES.ADMIN));
// Meta admite una sola respuesta privada por comentario y solo durante 7 días.
const SIETE_DIAS = 7 * 86400000;
const RESPONDIDO = ['PENDIENTE', 'PROCESANDO', 'LISTO', 'ENVIANDO', 'ENVIADO', 'INCIERTO'];
function comentarioVigente(evento, ahora) {
  const fecha = new Date(evento?.timestamp);
  return !Number.isNaN(fecha.getTime()) && ahora - fecha < SIETE_DIAS;
}
const resumen = { id: true, clave: true, canal: true, cuenta: true, contacto: true, nombre: true, humano: true, noLeidos: true, ultimoMensajeAt: true, ultimoDelClienteAt: true };
function canal(canal, variables) { return { canal, configurado: variables.every((v) => Boolean(env[v])), faltan: variables.filter((v) => !env[v]) }; }
async function buscar(id, tx = db) {
  const c = await tx.socialConversacion.findUnique({ where: { id } });
  if (!c || !['instagram', 'facebook', 'whatsapp'].includes(c.canal)) throw new NotFoundError('Conversación no encontrada.');
  return c;
}
router.get('/estado', asyncHandler(async (_req, res) => {
  const activo = env.SOCIAL_META_ENABLED;
  const cola = activo ? {
    pendientes: await db.socialTrabajo.count({ where: { estado: { in: ['PENDIENTE', 'PROCESANDO', 'LISTO', 'ENVIANDO'] } } }),
    inciertos: await db.socialTrabajo.count({ where: { estado: 'INCIERTO' } }),
    errores: await db.socialTrabajo.count({ where: { estado: 'ERROR' } }),
  } : { pendientes: 0, inciertos: 0, errores: 0 };
  return ok(res, {
    activo, webhookUrl: `${env.apiPublicUrl}${env.API_PREFIX}/social-bot/webhook`,
    ia: env.SOCIAL_BOT_ENABLED && Boolean(env.SOCIAL_BOT_API_KEY), pruebas: Boolean(env.SOCIAL_BOT_ENABLED && env.SOCIAL_BOT_TRIAL_PRODUCT), cola,
    canales: [
      canal('facebook', ['SOCIAL_META_APP_SECRET', 'SOCIAL_META_VERIFY_TOKEN', 'SOCIAL_META_FACEBOOK_PAGE_ID', 'SOCIAL_META_PAGE_TOKEN']),
      canal('instagram', ['SOCIAL_META_APP_SECRET', 'SOCIAL_META_VERIFY_TOKEN', 'SOCIAL_META_FACEBOOK_PAGE_ID', 'SOCIAL_META_INSTAGRAM_ID', 'SOCIAL_META_PAGE_TOKEN']),
      canal('whatsapp', ['SOCIAL_META_APP_SECRET', 'SOCIAL_META_VERIFY_TOKEN', 'SOCIAL_META_WHATSAPP_ID', 'SOCIAL_META_WHATSAPP_TOKEN']),
    ],
  });
}));
router.get('/conversaciones', validate({ query: z.object({
  canal: z.enum(['instagram', 'facebook', 'whatsapp']).optional(),
  humano: z.enum(['true', 'false']).optional(), busqueda: z.string().trim().max(120).optional(),
}) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const lista = await db.socialConversacion.findMany({ where: {
    canal: q.canal || { in: ['instagram', 'facebook', 'whatsapp'] },
    ...(q.humano ? { humano: q.humano === 'true' } : {}),
    ...(q.busqueda ? { OR: [{ nombre: { contains: q.busqueda } }, { contacto: { contains: q.busqueda } }] } : {}),
  }, orderBy: { ultimoMensajeAt: 'desc' }, take: 100,
  select: { ...resumen, trabajos: { where: { estado: { not: 'IGNORADO' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { autor: true, texto: true, respuesta: true, estado: true } } },
  });
  return ok(res, lista.map(({ clave: _clave, trabajos, ...c }) => ({ ...c, ultimo: trabajos[0] ? { texto: trabajos[0].respuesta || trabajos[0].texto, autor: trabajos[0].respuesta ? 'BOT' : trabajos[0].autor } : null })));
}));
router.get('/conversaciones/:id', validate({ params }), asyncHandler(async (req, res) => {
  const c = await buscar(req.params.id);
  const trabajos = await db.socialTrabajo.findMany({ where: { conversacionId: c.id, estado: { not: 'IGNORADO' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
  const privados = new Set(trabajos.filter((t) => t.autor === 'ADMIN' && t.evento?.tipo === 'respuesta_privada' && RESPONDIDO.includes(t.estado)).map((t) => t.evento.comentarioId));
  const ahora = new Date();
  const mensajes = trabajos.reverse().flatMap((t) => {
    const comentario = t.autor === 'CLIENTE' && t.evento?.tipo === 'comentario' && c.canal !== 'whatsapp'
      ? { vigente: comentarioVigente(t.evento, ahora), privado: privados.has(t.evento.comentarioId) } : null;
    const salida = [{ id: t.id, autor: t.autor, texto: t.texto, envio: t.autor === 'CLIENTE' ? 'RECIBIDO' : t.estado, createdAt: t.createdAt, error: t.error, comentario }];
    if (t.respuesta && t.autor === 'CLIENTE') salida.push({ id: `${t.id}-bot`, autor: 'BOT', texto: t.respuesta, envio: t.estado, createdAt: t.updatedAt, error: t.error });
    return salida;
  });
  // No descartar mensajes que llegaron entre la lectura y el marcado como leído.
  await db.socialConversacion.updateMany({ where: { id: c.id, ultimoMensajeAt: c.ultimoMensajeAt, noLeidos: c.noLeidos }, data: { noLeidos: 0 } });
  const prueba = await db.socialPrueba.findUnique({ where: { contacto: c.clave }, select: { url: true, expiresAt: true } });
  const vista = Object.fromEntries(Object.keys(resumen).filter((k) => k !== 'clave').map((k) => [k, c[k]]));
  return ok(res, { ...vista, ventanaAbierta: Boolean(ventana(c.ultimoDelClienteAt, new Date())), mensajes, prueba });
}));
router.patch('/conversaciones/:id/modo', validate({ params, body: z.object({ humano: z.boolean() }).strict() }), asyncHandler(async (req, res) => {
  await buscar(req.params.id);
  await db.socialConversacion.update({ where: { id: req.params.id }, data: { humano: req.body.humano, revision: { increment: 1 }, lease: null, busyUntil: null } });
  return ok(res, { humano: req.body.humano });
}));
const cuerpoRespuesta = z.object({
  texto: z.string().trim().min(1).max(1000),
  // Responder a un comentario concreto: por privado (abre el chat) o debajo del comentario.
  comentario: z.string().uuid().optional(),
  via: z.enum(['privado', 'publico']).optional(),
}).strict().refine((b) => !b.comentario === !b.via, { message: 'Indica el comentario y cómo responderlo.' });
router.post('/conversaciones/:id/responder', validate({ params, body: cuerpoRespuesta }), asyncHandler(async (req, res) => {
  if (!env.SOCIAL_META_ENABLED) throw new ConflictError('La conexión directa con Meta está apagada.');
  await db.$transaction(async (tx) => {
    const c = await buscar(req.params.id, tx);
    const tamano = c.canal === 'instagram' ? Buffer.byteLength(req.body.texto, 'utf8') : req.body.texto.length;
    if (tamano > 1000) throw new ValidationError('El mensaje supera el límite del canal. Acórtalo antes de enviarlo.');
    let destino = { tipo: 'privado', timestamp: new Date().toISOString() };
    if (req.body.comentario) {
      const original = await tx.socialTrabajo.findFirst({ where: { id: req.body.comentario, conversacionId: c.id, autor: 'CLIENTE' } });
      if (!original || original.evento?.tipo !== 'comentario' || !original.evento.comentarioId || c.canal === 'whatsapp') throw new NotFoundError('Comentario no encontrado.');
      if (!comentarioVigente(original.evento, new Date())) throw new ConflictError('Meta solo permite responder comentarios de los últimos 7 días.');
      if (req.body.via === 'privado') {
        const previas = await tx.socialTrabajo.findMany({ where: { conversacionId: c.id, autor: 'ADMIN', estado: { in: RESPONDIDO } }, select: { evento: true } });
        if (previas.some((t) => t.evento?.tipo === 'respuesta_privada' && t.evento.comentarioId === original.evento.comentarioId)) {
          throw new ConflictError('Ese comentario ya tiene su respuesta privada. Meta solo permite una: sigue la conversación cuando el cliente conteste.');
        }
      }
      // El timestamp es el del comentario: el plazo de 7 días se cuenta desde él.
      destino = { tipo: req.body.via === 'privado' ? 'respuesta_privada' : 'comentario', comentarioId: original.evento.comentarioId, timestamp: original.evento.timestamp };
    } else if (!ventana(c.ultimoDelClienteAt, new Date())) {
      throw new ConflictError('No hay una conversación privada abierta en las últimas 24 horas.');
    }
    await tx.socialConversacion.updateMany({ where: { id: c.id, humano: false }, data: { humano: true, revision: { increment: 1 } } });
    const actualizado = await tx.socialConversacion.update({ where: { id: c.id }, data: { humano: true, noLeidos: 0, lease: null, busyUntil: null, ultimoMensajeAt: new Date() } });
    const evento = randomUUID();
    await tx.socialTrabajo.create({ data: {
      clave: hash('admin', evento), conversacionId: c.id, autor: 'ADMIN', texto: req.body.texto, revision: actualizado.revision,
      evento: { canal: c.canal, cuenta: c.cuenta, contacto: c.contacto, evento, texto: req.body.texto, eco: false, ...destino },
    } });
  });
  return ok(res, { estado: 'encolado' });
}));
module.exports = router;
