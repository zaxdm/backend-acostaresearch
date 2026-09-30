'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { invitacionLimiter } = require('../../middlewares/rateLimit');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const gruposService = require('./grupos.service');

/**
 * Grupos (universidades y asesores). Ver `grupos.service`.
 *
 *   GET   /grupos/publico/:slug          lo que ve el alumno antes de unirse
 *   POST  /grupos/publico/:slug/unirse   se une con su cuenta y recibe su conector
 *   GET   /grupos/mios                   los que coordina, con el avance de cada alumno
 *   GET   /grupos                        panel (ADMIN)
 *   POST  /grupos                        panel: alta de un grupo vendido (ADMIN)
 *   PATCH /grupos/:id                    panel: apagar, ampliar, mover la fecha (ADMIN)
 */
const router = Router();

const MEDIOS = ['CORTESIA', 'YAPE', 'PLIN', 'TRANSFERENCIA', 'PAYPAL', 'WESTERN_UNION'];

const slugSchema = z.object({ slug: z.string().regex(/^[a-z0-9]{6,40}$/) });
const idSchema = z.object({ id: z.string().uuid() });

const fecha = z
  .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()])
  .optional()
  // Una fecha sola se entiende como el final de ese día en Lima. Sin valor
  // se queda en undefined («no tocarla»), y null la quita.
  .transform((valor) => {
    if (valor === undefined || valor === null) return valor;
    return valor.length === 10 ? new Date(`${valor}T23:59:59-05:00`) : new Date(valor);
  });

const crearSchema = z.object({
  nombre: z.string().trim().min(3, 'Ponle un nombre al grupo.').max(120),
  productCode: z.string().trim().min(2).max(40),
  cupos: z.coerce.number().int().min(1, 'Al menos un cupo.').max(1000),
  duracionDias: z.coerce.number().int().min(0).max(1095).default(0),
  cierraAt: fecha,
  coordinadorEmail: z.string().trim().email('Ese correo no es válido.').max(255),
  paymentMethod: z.enum(MEDIOS).default('CORTESIA'),
  paymentRef: z.string().trim().max(80).optional().nullable(),
  amountCents: z.coerce.number().int().min(0).optional().nullable(),
  note: z.string().trim().max(255).optional().nullable(),
});

const cambiarSchema = z.object({
  nombre: z.string().trim().min(3).max(120).optional(),
  cupos: z.coerce.number().int().min(1).max(1000).optional(),
  cierraAt: fecha,
  activo: z.boolean().optional(),
});

router.get(
  '/publico/:slug',
  validate({ params: slugSchema }),
  asyncHandler(async (req, res) => ok(res, await gruposService.publico(req.params.slug))),
);

router.post(
  '/publico/:slug/unirse',
  authenticate,
  invitacionLimiter,
  validate({ params: slugSchema }),
  asyncHandler(async (req, res) => ok(res, await gruposService.unirse(req.params.slug, req.user.id))),
);

router.get(
  '/mios',
  authenticate,
  asyncHandler(async (req, res) => ok(res, { grupos: await gruposService.mios(req.user.id) })),
);

router.get(
  '/',
  authenticate,
  authorize(ROLES.ADMIN),
  asyncHandler(async (_req, res) => ok(res, { grupos: await gruposService.listar() })),
);

router.post(
  '/',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ body: crearSchema }),
  asyncHandler(async (req, res) => {
    const grupo = await gruposService.crear({ ...req.body, createdById: req.user.id });
    return created(res, { grupo }, 'Grupo creado. Pásale el enlace al coordinador.');
  }),
);

router.patch(
  '/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ params: idSchema, body: cambiarSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { grupo: await gruposService.actualizar(req.params.id, req.body) }),
  ),
);

module.exports = router;
