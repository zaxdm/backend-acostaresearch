'use strict';

const { Router } = require('express');
const validate = require('../../middlewares/validate');
const { asistenteLimiter } = require('../../middlewares/rateLimit');
const { conversacionSchema } = require('./asistente.schema');
const asistenteController = require('./asistente.controller');

const router = Router();

// Público las dos: el asistente está para quien todavía no tiene cuenta.
router.get('/', asistenteController.estado);
router.post(
  '/mensaje',
  asistenteLimiter,
  validate({ body: conversacionSchema }),
  asistenteController.mensaje,
);

module.exports = router;
