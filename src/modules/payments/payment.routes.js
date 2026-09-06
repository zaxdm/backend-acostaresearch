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
  paymentIdParamSchema,
} = require('./payment.schema');
const paymentController = require('./payment.controller');
const manualRoutes = require('./manual.routes');

const router = Router();

// Pago manual por Yape: sus rutas van aparte porque la subida del comprobante
// necesita un cuerpo crudo y un techo de tamaño propio.
router.use('/manual', manualRoutes);

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

// Limpiar el historial. Va la última para que ninguna ruta con nombre fijo
// —«/recent», «/manual»— acabe interpretada como un identificador.
router.delete(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ params: paymentIdParamSchema }),
  paymentController.remove,
);

module.exports = router;
