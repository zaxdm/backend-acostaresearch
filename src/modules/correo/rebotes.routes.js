'use strict';

const crypto = require('node:crypto');
const express = require('express');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { procesarEventos } = require('./rebotes.service');

const router = express.Router();

/**
 * El secreto llega en la URL (`?token=`, que el registro ya tapa) o como
 * `Authorization: Bearer`: Brevo deja poner cualquiera de los dos.
 */
function tokenDe(req) {
  const cabecera = req.get('Authorization') ?? '';
  if (cabecera.startsWith('Bearer ')) return cabecera.slice(7).trim();
  return typeof req.query.token === 'string' ? req.query.token : '';
}

function coincide(recibido, esperado) {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST /correo/rebotes — el webhook de Brevo (Transaccional → Webhooks).
 *
 * Se contesta 200 enseguida y se procesa después: Brevo reintenta lo que tarda,
 * y el aviso no tiene por qué esperar a la base ni al correo.
 */
router.post('/rebotes', (req, res) => {
  if (!env.BREVO_WEBHOOK_TOKEN || !coincide(tokenDe(req), env.BREVO_WEBHOOK_TOKEN)) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No autorizado.' } });
  }

  res.json({ success: true });
  procesarEventos(req.body).catch((error) =>
    logger.error({ err: error }, 'No se pudo procesar un aviso de rebote de Brevo'),
  );
  return undefined;
});

module.exports = router;
