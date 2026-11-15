'use strict';
const { createHash } = require('node:crypto');
const { GoogleAuth } = require('google-auth-library');
const db = require('../../lib/prisma');
const logger = require('../../config/logger');

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const habilitado = () => Boolean(process.env.SOCIAL_FCM_PROJECT_ID);
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });

// Inyectables para verificar permisos, caducidad y reintentos sin contactar a Google.
function crearPush({ db, enviar, activo = habilitado, ahora = () => new Date() }) {
  async function encolar(tx, c, evento, clave) {
    if (!activo() || evento.eco) return;
    await tx.socialAviso.create({ data: { clave, conversacionId: c.id, canal: c.canal } });
  }

  async function autorizado(d) {
    // La familia sobrevive a la rotación; cerrar sesión revoca toda la familia.
    const session = await db.refreshToken.findFirst({ where: {
      familyId: d.familyId, userId: d.userId, sessionVersion: d.sessionVersion,
      revokedAt: null, expiresAt: { gt: ahora() },
      user: { role: 'ADMIN', status: 'ACTIVE', sessionVersion: d.sessionVersion },
    }, select: { id: true } });
    return Boolean(session);
  }

  let ocupado = false;
  async function pasar() {
    if (!activo() || ocupado) return;
    ocupado = true;
    try {
      const avisos = await db.socialAviso.findMany({ where: { proximoAt: { lte: ahora() } },
        orderBy: { createdAt: 'asc' }, take: 20 });
      if (!avisos.length) return;
      const dispositivos = await db.socialDispositivo.findMany();
      const validos = [];
      for (const d of dispositivos) {
        if (await autorizado(d)) validos.push(d);
        else await db.socialDispositivo.deleteMany({ where: { tokenHash: d.tokenHash, familyId: d.familyId } });
      }
      for (const aviso of avisos) {
        if (ahora() - aviso.createdAt > 3600000) {
          await db.socialAviso.deleteMany({ where: { clave: aviso.clave } });
          continue;
        }
        let retry = false;
        for (const d of validos) {
          try { await enviar(d.token, aviso); }
          catch (error) {
            if (error.tokenInvalido) {
              await db.socialDispositivo.deleteMany({ where: { tokenHash: d.tokenHash, familyId: d.familyId } });
            } else {
              retry = true;
              logger.warn({ codigo: 'SOCIAL_PUSH_FAILED' }, 'No se pudo enviar un aviso de redes; se reintentará');
            }
          }
        }
        if (retry && aviso.intentos < 5) {
          await db.socialAviso.update({ where: { clave: aviso.clave }, data: {
            intentos: { increment: 1 }, proximoAt: new Date(ahora().getTime() + 30000 * 2 ** aviso.intentos),
          } });
        } else await db.socialAviso.deleteMany({ where: { clave: aviso.clave } });
      }
    } finally { ocupado = false; }
  }
  return { encolar, pasar };
}

async function enviar(token, aviso) {
  const client = await auth.getClient();
  const canal = { instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp' }[aviso.canal] || 'redes';
  try {
    await client.request({
      url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(process.env.SOCIAL_FCM_PROJECT_ID)}/messages:send`,
      method: 'POST', timeout: 10000, retry: false,
      data: { message: {
        token, notification: { title: `Nuevo mensaje en ${canal}`, body: 'Toca para abrir Atención en redes.' },
        data: { conversacionId: aviso.conversacionId },
        android: { priority: 'high', ttl: '3600s', notification: {
          tag: aviso.clave, sound: 'default', visibility: 'PRIVATE',
        } },
      } },
    });
  } catch (error) {
    // INVALID_ARGUMENT puede ser un fallo del payload: solo UNREGISTERED elimina el token.
    const details = error.response?.data?.error?.details || [];
    error.tokenInvalido = details.some((d) => d.errorCode === 'UNREGISTERED');
    throw error;
  }
}

module.exports = { ...crearPush({ db, enviar }), crearPush, habilitado, hashToken };
