'use strict';

const express = require('express');
const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { paymentLimiter, capturaLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const env = require('../../config/env');
const {
  registrarQuerySchema,
  revisarCapturaQuerySchema,
  paymentParamsSchema,
  rechazarSchema,
  crearBilleteraSchema,
  cambiarBilleteraSchema,
} = require('./manual.schema');
const manualController = require('./manual.controller');
const { billeteraController } = manualController;

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

// Lee la captura antes de enviarla y avisa si no parece un comprobante. Usa el
// su propio limitador: cada llamada es un OCR.
router.post(
  '/revisar-captura',
  authenticate,
  capturaLimiter,
  cuerpoDeImagen,
  validate({ query: revisarCapturaQuerySchema }),
  manualController.revisarCaptura,
);

// ── Revisión: solo administradores ────────────────────────────────────────
router.use(authenticate, authorize(ROLES.ADMIN));

// El catálogo de billeteras de país. Va antes de las rutas con `/:id` para que
// «billeteras» no se lea como un identificador de pago.
router.get('/billeteras', billeteraController.listar);
router.post('/billeteras', validate({ body: crearBilleteraSchema }), billeteraController.crear);
router.patch(
  '/billeteras/:id',
  validate({ params: paymentParamsSchema, body: cambiarBilleteraSchema }),
  billeteraController.cambiar,
);

router.get('/pending', manualController.pendientes);

// Lo ya resuelto. Va aparte de la bandeja porque son dos preguntas distintas:
// qué me falta por mirar y qué pasó con aquel pago.
router.get('/history', manualController.historial);

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
