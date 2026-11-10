'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const epicuroEntrada = require('./epicuro.entrada');

const router = Router();

const cuerpo = z.object({
  productCode: z.string().max(60).optional(),
  frase: z.string().max(400).optional(),
});

// El pase para entrar a Epicuro.ai con la misma cuenta (ver `epicuro.entrada`).
router.post(
  '/entrada',
  authenticate,
  validate({ body: cuerpo }),
  asyncHandler(async (req, res) =>
    ok(res, await epicuroEntrada.pase({ userId: req.user.id, productCode: req.body.productCode, frase: req.body.frase })),
  ),
);

module.exports = router;
