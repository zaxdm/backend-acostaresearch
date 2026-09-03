'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const { grantPackSchema } = require('./billing.schema');
const billingController = require('./billing.controller');

const router = Router();

// Los planes son públicos: la web de venta los necesita sin sesión.
router.get('/plans', billingController.plans);

router.get('/balance', authenticate, billingController.balance);

// Activación manual tras confirmar un Yape. Cuando haya pasarela, el webhook
// llamará al mismo servicio con los mismos datos.
router.post(
  '/packs',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ body: grantPackSchema }),
  billingController.grant,
);
router.get('/packs', authenticate, authorize(ROLES.ADMIN), billingController.recent);

module.exports = router;
