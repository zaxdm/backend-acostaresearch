'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { invitacionLimiter } = require('../../middlewares/rateLimit');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const referidosService = require('./referidos.service');

/**
 * Referidos. Ver `referidos.service`.
 *
 *   GET  /referidos/mio             su código, su enlace y a quién invitó
 *   GET  /referidos/codigo/:codigo  de quién es un código (público, para /planes)
 *   POST /referidos/apuntarse       «me invitó…», antes de comprar
 *   GET  /referidos                 panel: los últimos (ADMIN)
 *   POST /referidos/:id/anular      panel: anular uno pendiente (ADMIN)
 */
const router = Router();

const codigoSchema = z.object({ codigo: z.string().trim().min(1).max(24) });
const idSchema = z.object({ id: z.string().uuid() });

router.get(
  '/mio',
  authenticate,
  asyncHandler(async (req, res) => ok(res, await referidosService.miPanel(req.user.id))),
);

router.get(
  '/codigo/:codigo',
  invitacionLimiter,
  validate({ params: codigoSchema }),
  asyncHandler(async (req, res) => ok(res, await referidosService.deQuienEs(req.params.codigo))),
);

router.post(
  '/apuntarse',
  authenticate,
  invitacionLimiter,
  validate({ body: codigoSchema }),
  asyncHandler(async (req, res) => {
    const resultado = await referidosService.apuntarse(req.user.id, req.body.codigo);
    return ok(res, resultado, {
      message: `Listo: te invitó ${resultado.nombre}. Al empezar el método recibes ${resultado.dias} días extra.`,
    });
  }),
);

router.get(
  '/',
  authenticate,
  authorize(ROLES.ADMIN),
  asyncHandler(async (_req, res) => ok(res, { referidos: await referidosService.listar() })),
);

router.post(
  '/:id/anular',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => ok(res, await referidosService.anular(req.params.id))),
);

module.exports = router;
