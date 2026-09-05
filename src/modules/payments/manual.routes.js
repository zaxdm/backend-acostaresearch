'use strict';

const express = require('express');
const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { paymentLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const env = require('../../config/env');
const {
  registrarQuerySchema,
  paymentParamsSchema,
  rechazarSchema,
} = require('./manual.schema');
const manualController = require('./manual.controller');

const router = Router();

/**
 * La captura llega como cuerpo crudo.
 *
 * El resto de la API está limitada a 100 KB, que es lo correcto para JSON y
 * demasiado poco para la foto de una pantalla de móvil. En vez de subir ese
 * techo para todo el mundo, se abre solo aquí y solo para imágenes.
 *
 * `type` acota qué se parsea, pero no se le cree: el formato real se comprueba
 * leyendo los primeros bytes en `proof.storage`.
 */
const cuerpoDeImagen = express.raw({
  type: ['image/png', 'image/jpeg', 'image/webp'],
  limit: env.PROOF_MAX_BYTES,
});

// Público: la web enseña los datos del Yape antes de que nadie inicie sesión.
router.get('/info', manualController.datosDePago);

router.post(
  '/',
  authenticate,
  paymentLimiter,
  cuerpoDeImagen,
  validate({ query: registrarQuerySchema }),
  manualController.registrar,
);

// ── Revisión: solo administradores ────────────────────────────────────────
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/pending', manualController.pendientes);

router.get(
  '/:id/proof',
  validate({ params: paymentParamsSchema }),
  manualController.comprobante,
);

router.post(
  '/:id/approve',
  validate({ params: paymentParamsSchema }),
  manualController.aprobar,
);

router.post(
  '/:id/reject',
  validate({ params: paymentParamsSchema, body: rechazarSchema }),
  manualController.rechazar,
);

module.exports = router;
