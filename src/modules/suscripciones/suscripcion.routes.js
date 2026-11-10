'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const suscripcionService = require('./suscripcion.service');

/** Cobro mensual con Culqi (10-nov-2026): ver `suscripcion.service`. */
const router = Router();
const idParam = z.object({ id: z.string().uuid('Identificador no válido.') });

// Las del usuario, para «Mis compras».
router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => ok(res, await suscripcionService.mias(req.user.id))),
);

// Cortar el cobro mensual. Lo pagado dura hasta su fecha.
router.post(
  '/:id/cancelar',
  authenticate,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const porAdmin = req.user.role === ROLES.ADMIN;
    const fila = await suscripcionService.cancelar({ userId: req.user.id, id: req.params.id, porAdmin });
    return ok(res, fila, { message: 'Listo: ya no se te cobrará cada mes. Tu plan sigue hasta su fecha.' });
  }),
);

// Revisar en Culqi las cuotas de todas (por si un aviso se perdió). Solo ADMIN.
router.post(
  '/conciliar',
  authenticate,
  authorize(ROLES.ADMIN),
  asyncHandler(async (_req, res) => ok(res, await suscripcionService.conciliarTodas())),
);

// Crear ya en Culqi los planes mensuales (para verlos en su panel). Solo ADMIN.
router.post(
  '/planes-en-culqi',
  authenticate,
  authorize(ROLES.ADMIN),
  asyncHandler(async (_req, res) => ok(res, await suscripcionService.planesEnCulqi())),
);

module.exports = router;
