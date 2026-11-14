'use strict';
const { Router } = require('express');
const env = require('../../config/env');
const asyncHandler = require('../../shared/http/asyncHandler');
const { autorizado } = require('./social.auth');
const { firmaValida } = require('./social.meta');
const runtime = require('./social.runtime');
const router = Router();
router.get('/', (req, res) => {
  if (req.query['hub.mode'] !== 'subscribe' || !autorizado(`Bearer ${req.query['hub.verify_token'] || ''}`, env.SOCIAL_META_VERIFY_TOKEN)) return res.sendStatus(403);
  return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
});
router.post('/', asyncHandler(async (req, res) => {
  if (!env.SOCIAL_META_ENABLED) return res.sendStatus(503);
  if (!firmaValida(req.rawBody, req.get('x-hub-signature-256'), env.SOCIAL_META_APP_SECRET)) return res.sendStatus(401);
  // Solo confirmar después de persistir. Una caída de BD provoca un reintento de Meta.
  await runtime.recibir(req.body);
  return res.sendStatus(200);
}));
module.exports = router;
