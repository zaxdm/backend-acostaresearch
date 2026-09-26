'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const ventasService = require('./ventas.service');

/** Ventas mensuales del panel. Solo ADMIN. */
const router = Router();

const mesParamsSchema = z.object({
  anio: z.coerce.number().int().min(2024).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
});

router.use(authenticate, authorize(ROLES.ADMIN));

router.get(
  '/meses',
  asyncHandler(async (_req, res) => ok(res, await ventasService.listar())),
);

router.get(
  '/meses/:anio/:mes/pdf',
  validate({ params: mesParamsSchema }),
  asyncHandler(async (req, res) => {
    const { nombre, pdf } = await ventasService.pdfDelMes({
      anio: Number(req.params.anio),
      mes: Number(req.params.mes),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdf);
  }),
);

module.exports = router;
