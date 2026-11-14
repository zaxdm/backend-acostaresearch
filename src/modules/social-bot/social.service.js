'use strict';
const { createHash, randomUUID, randomBytes } = require('node:crypto');
const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { ConflictError, ValidationError } = require('../../shared/errors/AppError');
const { generarConRespaldo } = require('../../lib/gemini');
const { contratoDelProducto } = require('../licensing/license.service');
const asistente = require('../asistente/asistente.service');
const { crearTopeDiario } = require('../asistente/asistente.tope');
const { sistema } = require('./social.prompt');
const { solicitaPrueba } = require('./social.schema');
const { limpiarTexto } = require('./social.text');
const hash = (...partes) => createHash('sha256').update(JSON.stringify(partes)).digest('hex');
const identidad = (d) => hash(d.canal, d.cuenta, d.contacto);
const tope = crearTopeDiario(env.SOCIAL_BOT_MAX_DIARIO);
const resultado = (texto, extra = {}) => ({ success: true, texto, humano: false, pruebaUrl: '', ...extra });
// Lo que el modelo recibe por un comentario. El comentario y el post son datos del cliente y de la página.
function pedidoComentario(d) {
  const post = d.publicacion ? ` que dice: «${d.publicacion}»` : '';
  return `[Comentario público] La persona comentó «${d.texto}» en nuestra publicación${post}. `
    + 'Escríbele por mensaje privado el primer mensaje de venta (paso 1, sin precio) del producto del que trata la publicación. '
    + 'Si el comentario no pide información ni muestra interés (una queja, un insulto, algo personal o sin relación), responde solo [[PERSONA]].';
}

async function conversacion(d) {
  const clave = identidad(d);
  const datos = { canal: d.canal, cuenta: d.cuenta, contacto: d.contacto, ...(d.nombre ? { nombre: d.nombre.slice(0, 120) } : {}) };
  return prisma.socialConversacion.upsert({ where: { clave }, update: datos, create: { clave, historial: [], ...datos } });
}

async function atender(d) {
  if (!env.SOCIAL_BOT_ENABLED) return resultado('', { estado: 'apagado' });
  const claveEvento = hash(d.canal, d.cuenta, d.contacto, d.evento);
  const previo = await prisma.socialEvento.findUnique({ where: { clave: claveEvento } });
  if (previo) return previo.respuesta;
  const c = await conversacion(d);
  if (c.humano) return resultado('', { humano: true, estado: 'persona' });
  const lease = randomUUID();
  const adquirido = await prisma.socialConversacion.updateMany({
    where: { id: c.id, humano: false, OR: [{ busyUntil: null }, { busyUntil: { lt: new Date() } }] },
    data: { lease, busyUntil: new Date(Date.now() + 180000) },
  });
  if (!adquirido.count) throw new ConflictError('Conversación ocupada. Reintenta con el mismo evento.');
  try {
    // Leer después del cerrojo: puede haber terminado otro mensaje desde la primera lectura.
    const actual = await prisma.socialConversacion.findUnique({ where: { id: c.id } });
    const repetido = await prisma.socialEvento.findUnique({ where: { clave: claveEvento } });
    if (repetido) return repetido.respuesta;
    let respuesta;
    let contrato;
    if (d.tipo === 'comentario') {
      if (!env.SOCIAL_BOT_API_KEY) throw new ConflictError('Falta configurar la IA del bot.');
      if (!tope.intentar()) throw new ConflictError('Se alcanzó el límite diario del bot.');
      const { planes } = await asistente.preciosVigentes();
      const generado = await generarConRespaldo({
        modelos: [env.SOCIAL_BOT_MODEL], clave: env.SOCIAL_BOT_API_KEY,
        sistema: sistema({ planes, appUrl: env.APP_URL, pruebas: Boolean(env.SOCIAL_BOT_TRIAL_PRODUCT) }),
        mensajes: [{ rol: 'usuario', texto: pedidoComentario(d) }], maxTokens: 600,
      });
      const limpio = limpiarTexto(generado.texto, env.APP_URL);
      respuesta = resultado(limpio.texto.slice(0, 4000), { humano: limpio.humano || !limpio.texto, estado: 'comentario' });
    } else if (d.accion === 'prueba') {
      if (!solicitaPrueba(d.texto)) throw new ValidationError('La persona debe solicitar la prueba explícitamente.');
      if (!env.SOCIAL_BOT_TRIAL_PRODUCT) throw new ConflictError('No hay un producto de prueba configurado.');
      contrato = await contratoDelProducto(env.SOCIAL_BOT_TRIAL_PRODUCT);
      if (!contrato.planId) throw new ConflictError('El producto de prueba no está activo.');
    } else {
      if (!env.SOCIAL_BOT_API_KEY) throw new ConflictError('Falta configurar la IA del bot.');
      if (!tope.intentar()) throw new ConflictError('Se alcanzó el límite diario del bot.');
      const { planes } = await asistente.preciosVigentes();
      const generado = await generarConRespaldo({
        modelos: [env.SOCIAL_BOT_MODEL], clave: env.SOCIAL_BOT_API_KEY,
        sistema: sistema({ planes, appUrl: env.APP_URL, pruebas: Boolean(env.SOCIAL_BOT_TRIAL_PRODUCT) }),
        mensajes: [...actual.historial, { rol: 'usuario', texto: d.texto }], maxTokens: 600,
      });
      // El modelo nunca puede entregar por su cuenta un enlace de prueba.
      const limpio = limpiarTexto(generado.texto, env.APP_URL);
      respuesta = resultado(limpio.texto.slice(0, 4000), { humano: limpio.humano, estado: 'respondido' });
      if (!respuesta.texto) respuesta = resultado('Te paso con una persona del equipo.', { humano: true, estado: 'persona' });
    }
    return await prisma.$transaction(async (tx) => {
      // Fencing: una respuesta tardía no puede sobreescribir una intervención humana u otra solicitud.
      const vigente = await tx.socialConversacion.updateMany({
        where: { id: c.id, lease, humano: false, busyUntil: { gt: new Date() } },
        data: { busyUntil: new Date(Date.now() + 30000) },
      });
      if (!vigente.count) return resultado('', { humano: true, estado: 'interrumpido' });
      if (contrato) {
        const existente = await tx.socialPrueba.findUnique({ where: { contacto: c.clave } });
        if (existente) {
          respuesta = existente.expiresAt > new Date()
            ? resultado(`Tu prueba ya está disponible: ${existente.url}`, { pruebaUrl: existente.url, estado: 'prueba_existente' })
            : resultado('Ya utilizaste tu prueba gratuita. ¿Te paso los planes para continuar?', { estado: 'prueba_utilizada' });
        } else {
          const slug = randomBytes(18).toString('hex');
          const enlace = await tx.trialLink.create({ data: {
            slug, name: 'Prueba individual del bot', productCode: env.SOCIAL_BOT_TRIAL_PRODUCT,
            seats: 1, accessMinutes: 20, callsPerDay: 5,
          } });
          const url = `${env.APP_URL.replace(/\/+$/, '')}/prueba/${slug}`;
          const expiresAt = new Date(enlace.createdAt.getTime() + 20 * 60000);
          await tx.socialPrueba.create({ data: { contacto: c.clave, url, expiresAt } });
          respuesta = resultado(`Aquí tienes tu prueba gratuita de 20 minutos y hasta 5 consultas. El tiempo comienza ahora: ${url}`, { pruebaUrl: url, estado: 'prueba_creada' });
        }
      }
      const historial = [...actual.historial, { rol: 'usuario', texto: d.texto }, { rol: 'asistente', texto: respuesta.texto }].slice(-20);
      // Si el bot la deriva (pago, queja), queda con el equipo sin plazo: no vuelve sola al bot.
      await tx.socialConversacion.update({ where: { id: c.id }, data: { historial, humano: respuesta.humano, ...(respuesta.humano ? { humanoHasta: null } : {}), lease: null, busyUntil: null } });
      await tx.socialEvento.create({ data: { clave: claveEvento, respuesta } });
      return respuesta;
    });
  } finally {
    await prisma.socialConversacion.updateMany({ where: { id: c.id, lease }, data: { lease: null, busyUntil: null } });
  }
}
async function modo(d) {
  const c = await conversacion(d);
  await prisma.socialConversacion.update({ where: { id: c.id }, data: { humano: d.humano, revision: { increment: 1 }, lease: null, busyUntil: null } });
}
async function purgar() {
  if (!env.SOCIAL_BOT_ENABLED && !env.SOCIAL_META_ENABLED) return;
  // Se conservan las huellas de pruebas usadas para que la purga no renueve el beneficio.
  await prisma.socialEvento.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86400000) } } });
  if (env.SOCIAL_META_ENABLED) await prisma.socialTrabajo.deleteMany({ where: {
    createdAt: { lt: new Date(Date.now() - 90 * 86400000) }, estado: { in: ['ENVIADO', 'IGNORADO', 'HUMANO', 'ERROR', 'INCIERTO'] },
  } });
  // Mantener también el modo humano; solo se elimina el texto antiguo.
  await prisma.socialConversacion.updateMany({
    where: { updatedAt: { lt: new Date(Date.now() - 90 * 86400000) }, busyUntil: null },
    data: { historial: [] },
  });
}
module.exports = { atender, modo, purgar, identidad, hash, pedidoComentario };
