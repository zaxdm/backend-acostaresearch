'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { reclamoLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const { reclamoBodySchema, respuestaSchema, numeroParamSchema } = require('./reclamo.schema');
const reclamoController = require('./reclamo.controller');

const router = Router();

// Públicas: el libro está para cualquiera, compre o no, y sin cuenta.
router.get('/proveedor', reclamoController.proveedor);
router.post('/', reclamoLimiter, validate({ body: reclamoBodySchema }), reclamoController.registrar);

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/', reclamoController.listar);
router.post(
  '/:numero/respuesta',
  validate({ params: numeroParamSchema, body: respuestaSchema }),
  reclamoController.responder,
);

module.exports = router;
