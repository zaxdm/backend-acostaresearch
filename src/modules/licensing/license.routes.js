'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { authLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  generateCodesSchema,
  redeemSchema,
  revokeSchema,
  idParamSchema,
  listQuerySchema,
} = require('./license.schema');
const licenseController = require('./license.controller');

const router = Router();

// Todo el módulo exige sesión: una licencia siempre pertenece a una cuenta.
router.use(authenticate);

// ── Comprador ──────────────────────────────────────────────────────────────
// El canje se limita por ráfagas: un código son 12 caracteres y sin freno se
// podría barrer el espacio a fuerza bruta.
router.post('/redeem', authLimiter, validate({ body: redeemSchema }), licenseController.redeem);
router.get('/mine', licenseController.mine);
router.post(
  '/mine/:id/rotate',
  validate({ params: idParamSchema }),
  licenseController.rotate,
);

// ── Administración ─────────────────────────────────────────────────────────
router.use(authorize(ROLES.ADMIN));

router.post('/codes', validate({ body: generateCodesSchema }), licenseController.generate);
router.get('/codes', validate({ query: listQuerySchema }), licenseController.codes);
router.delete('/codes/:id', validate({ params: idParamSchema }), licenseController.voidCode);

router.get('/', validate({ query: listQuerySchema }), licenseController.list);
router.get('/review', licenseController.review);
router.get('/:id', validate({ params: idParamSchema }), licenseController.inspect);
router.post(
  '/:id/revoke',
  validate({ params: idParamSchema, body: revokeSchema }),
  licenseController.revoke,
);
router.post(
  '/:id/reactivate',
  validate({ params: idParamSchema }),
  licenseController.reactivate,
);

module.exports = router;
