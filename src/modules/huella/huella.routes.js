'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const huellaService = require('./huella.service');

const router = Router();

// El enlace firmado para abrir Huella IA desde el panel.
router.get(
  '/enlace',
  authenticate,
  asyncHandler(async (req, res) => ok(
      res,
      await huellaService.enlace({ userId: req.user.id, email: req.user.email, esAdmin: req.user.role === ROLES.ADMIN }),
    )),
);

// Mandar a Huella el avance de su proyecto (11-nov-2026) y abrirlo allí.
router.post(
  '/avance/:productCode',
  authenticate,
  asyncHandler(async (req, res) =>
    ok(
      res,
      await huellaService.analizarAvance({
        userId: req.user.id,
        email: req.user.email,
        productCode: String(req.params.productCode).slice(0, 60),
        esAdmin: req.user.role === ROLES.ADMIN,
      }),
    ),
  ),
);

module.exports = router;
