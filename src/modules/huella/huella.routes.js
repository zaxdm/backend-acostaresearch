'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const huellaService = require('./huella.service');

const router = Router();

// El enlace firmado para abrir Huella IA desde el panel.
router.get(
  '/enlace',
  authenticate,
  asyncHandler(async (req, res) => ok(res, await huellaService.enlace({ userId: req.user.id, email: req.user.email }))),
);

module.exports = router;
