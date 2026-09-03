'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { paymentLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  createOrderSchema,
  orderParamsSchema,
  providerQuerySchema,
} = require('./payment.schema');
const paymentController = require('./payment.controller');

const router = Router();

// Público: la web de venta necesita saber si hay pago en línea sin pedir sesión.
router.get('/providers', paymentController.providers);

router.post(
  '/orders',
  authenticate,
  paymentLimiter,
  validate({ body: createOrderSchema }),
  paymentController.createOrder,
);

// Confirmar el cobro NO se limita por ráfagas: el usuario ya aprobó el pago en
// la pasarela y bloquearlo aquí lo dejaría pagado y sin palabras.
router.post(
  '/orders/:orderId/capture',
  authenticate,
  validate({ params: orderParamsSchema, query: providerQuerySchema }),
  paymentController.capture,
);

router.post(
  '/orders/:orderId/cancel',
  authenticate,
  validate({ params: orderParamsSchema, query: providerQuerySchema }),
  paymentController.cancel,
);

router.get('/', authenticate, paymentController.mine);
router.get('/recent', authenticate, authorize(ROLES.ADMIN), paymentController.recent);

module.exports = router;
