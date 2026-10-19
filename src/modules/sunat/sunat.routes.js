'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const { NotFoundError } = require('../../shared/errors/AppError');
const sunatService = require('./sunat.service');

/**
 * Boletas y notas de crédito.
 *  - El cliente: sus boletas (para «Mis compras») y el PDF de cada una.
 *  - ADMIN: la lista, el XML, la CDR, reenviar el correo y anular.
 */
const router = Router();

const idSchema = z.object({ id: z.string().uuid() });
const anularSchema = z.object({
  motivo: z.string().trim().min(3).max(200),
  refacturar: z.boolean().default(false),
});

function mandarArchivo(res, { nombre, tipo, contenido }) {
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(contenido);
}

router.use(authenticate);

router.get(
  '/mis-boletas',
  asyncHandler(async (req, res) => ok(res, { boletas: await sunatService.misBoletas(req.user.id) })),
);

router.get(
  '/comprobantes/:id/pdf',
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const archivo = await sunatService.pdfDe({
      id: req.params.id,
      userId: req.user.id,
      esAdmin: req.user.role === ROLES.ADMIN,
    });
    if (!archivo) throw new NotFoundError('No encontramos ese comprobante.');
    return mandarArchivo(res, { nombre: archivo.nombre, tipo: 'application/pdf', contenido: archivo.contenido });
  }),
);

// ── Solo ADMIN ────────────────────────────────────────────────────────────
const soloAdmin = authorize(ROLES.ADMIN);

router.get(
  '/comprobantes',
  soloAdmin,
  asyncHandler(async (_req, res) => ok(res, { comprobantes: await sunatService.listar() })),
);

for (const cual of ['xml', 'cdr']) {
  router.get(
    `/comprobantes/:id/${cual}`,
    soloAdmin,
    validate({ params: idSchema }),
    asyncHandler(async (req, res) => {
      const archivo = await sunatService.archivo(req.params.id, cual);
      if (!archivo) throw new NotFoundError(cual === 'cdr' ? 'Este comprobante no tiene CDR.' : 'No encontramos ese comprobante.');
      return mandarArchivo(res, archivo);
    }),
  );
}

router.post(
  '/comprobantes/:id/reenviar',
  soloAdmin,
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    const correo = await sunatService.reenviarCorreo(req.params.id);
    if (!correo) throw new NotFoundError('No encontramos ese comprobante.');
    return ok(res, { correo });
  }),
);

router.post(
  '/comprobantes/:id/anular',
  soloAdmin,
  validate({ params: idSchema, body: anularSchema }),
  asyncHandler(async (req, res) => {
    const resultado = await sunatService.anularPorId({ id: req.params.id, ...req.body });
    return ok(res, resultado);
  }),
);

module.exports = router;
