'use strict';
const env = require('../../config/env');
const logger = require('../../config/logger');
const db = require('../../lib/prisma');
const engine = require('./social.service');
const transport = require('./social.meta');
const { crearWorker } = require('./social.worker');
const push = require('./social.push');
const ids = () => ({ facebookPageId: env.SOCIAL_META_FACEBOOK_PAGE_ID, instagramAccountId: env.SOCIAL_META_INSTAGRAM_ID, whatsappPhoneNumberId: env.SOCIAL_META_WHATSAPP_ID });
const config = (canal) => ({
  token: canal === 'whatsapp' ? env.SOCIAL_META_WHATSAPP_TOKEN : env.SOCIAL_META_PAGE_TOKEN,
  version: env.SOCIAL_META_API_VERSION, facebookPageId: env.SOCIAL_META_FACEBOOK_PAGE_ID,
});
const worker = crearWorker({ db, engine, transport, config, notificar: push.encolar });
async function recibir(cuerpo) {
  const eventos = transport.extraerEventos(cuerpo, ids());
  await worker.recibir(eventos);
  return eventos.length;
}
// Mientras Meta no conceda acceso avanzado, los comentarios de Facebook se leen por la API.
const SONDEO_MS = 90000;
let ultimoSondeo = 0;
async function sondearFacebook() {
  if (!env.SOCIAL_META_ENABLED || !env.SOCIAL_FB_SONDEO || !env.SOCIAL_META_FACEBOOK_PAGE_ID || Date.now() - ultimoSondeo < SONDEO_MS) return;
  ultimoSondeo = Date.now();
  try {
    const eventos = await transport.comentariosRecientes({ ...config('facebook'), desde: new Date(Date.now() - 86400000) });
    if (eventos.length) await worker.recibir(eventos);
  } catch (error) {
    logger.warn({ codigo: 'SOCIAL_FB_SONDEO', status: error.status, metaCode: error.code }, 'No se pudieron leer los comentarios de Facebook');
  }
}
async function pasar() {
  await sondearFacebook();
  if (env.SOCIAL_META_ENABLED) await worker.pasar();
  await push.pasar();
}
const usaWhatsapp = () => Boolean(env.SOCIAL_META_ENABLED && env.SOCIAL_META_WHATSAPP_ID && env.SOCIAL_META_WHATSAPP_ID === env.WHATSAPP_PHONE_NUMBER_ID);
module.exports = { recibir, pasar, usaWhatsapp, ids, sondearFacebook };
