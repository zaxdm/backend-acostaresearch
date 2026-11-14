'use strict';
const env = require('../../config/env');
const db = require('../../lib/prisma');
const engine = require('./social.service');
const transport = require('./social.meta');
const { crearWorker } = require('./social.worker');
const ids = () => ({ facebookPageId: env.SOCIAL_META_FACEBOOK_PAGE_ID, instagramAccountId: env.SOCIAL_META_INSTAGRAM_ID, whatsappPhoneNumberId: env.SOCIAL_META_WHATSAPP_ID });
const config = (canal) => ({
  token: canal === 'whatsapp' ? env.SOCIAL_META_WHATSAPP_TOKEN : env.SOCIAL_META_PAGE_TOKEN,
  version: env.SOCIAL_META_API_VERSION, facebookPageId: env.SOCIAL_META_FACEBOOK_PAGE_ID,
});
const worker = crearWorker({ db, engine, transport, config });
async function recibir(cuerpo) {
  const eventos = transport.extraerEventos(cuerpo, ids());
  await worker.recibir(eventos);
  return eventos.length;
}
async function pasar() { if (env.SOCIAL_META_ENABLED) await worker.pasar(); }
const usaWhatsapp = () => Boolean(env.SOCIAL_META_ENABLED && env.SOCIAL_META_WHATSAPP_ID && env.SOCIAL_META_WHATSAPP_ID === env.WHATSAPP_PHONE_NUMBER_ID);
module.exports = { recibir, pasar, usaWhatsapp, ids };
