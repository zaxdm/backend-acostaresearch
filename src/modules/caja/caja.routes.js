'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const cajaService = require('./caja.service');

/** Flujo de caja del panel. Solo ADMIN. */
const router = Router();

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato AAAA-MM-DD.');
const monto = z.number().int().positive().max(1_000_000_000);
const moneda = z.enum(['PEN', 'USD']).default('PEN');
const opcional = (max) => z.string().max(max).nullish();

const movimientoSchema = z.object({
  fecha: dia,
  tipo: z.enum(['ENTRADA', 'SALIDA']),
  montoCents: monto,
  moneda,
  concepto: z.string().trim().min(1, 'Escribe de qué es.').max(200),
  categoria: opcional(40),
  medio: opcional(40),
});

const inicioSchema = z.object({
  fecha: dia,
  montoCents: z.number().int().min(0).max(1_000_000_000),
  moneda,
});

router.use(authenticate, authorize(ROLES.ADMIN));

router.get(
  '/',
  validate({
    query: z.object({
      anio: z.coerce.number().int().min(2024).max(2100).optional(),
      mes: z.coerce.number().int().min(1).max(12).optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await cajaService.mes(req.query))),
);

router.put(
  '/inicio',
  validate({ body: inicioSchema }),
  asyncHandler(async (req, res) => ok(res, await cajaService.fijarInicio(req.body, req.user.id))),
);

router.post(
  '/movimientos',
  validate({ body: movimientoSchema }),
  asyncHandler(async (req, res) => ok(res, await cajaService.crear(req.body, req.user.id))),
);

router.put(
  '/movimientos/:id',
  validate({ params: z.object({ id: z.string().uuid() }), body: movimientoSchema }),
  asyncHandler(async (req, res) => ok(res, await cajaService.actualizar(req.params.id, req.body))),
);

router.delete(
  '/movimientos/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => ok(res, await cajaService.borrar(req.params.id))),
);

module.exports = router;
