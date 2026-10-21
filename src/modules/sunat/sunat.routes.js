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
 *  - ADMIN: los servicios cobrados fuera de la web (asesorías…), que el
 *    emisor factura como una venta más.
 */
const router = Router();

const idSchema = z.object({ id: z.string().uuid() });
const anularSchema = z.object({
  motivo: z.string().trim().min(3).max(200),
  refacturar: z.boolean().default(false),
});

/**
 * Un servicio cobrado fuera de la web. El documento depende del tipo: DNI de
 * 8 dígitos; carné o pasaporte, letras y números; sin documento o extranjero
 * sin documento, nada (el extranjero, con su país).
 */
const servicioSchema = z
  .object({
    concepto: z.string().trim().min(3).max(200),
    importeCents: z.number().int().positive().max(10_000_000),
    moneda: z.enum(['PEN', 'USD']),
    pagadoEn: z.string().datetime({ offset: true }),
    medio: z.string().trim().max(40).optional(),
    clienteTipoDoc: z.enum(['-', '0', '1', '4', '7']),
    clienteNumDoc: z.string().trim().max(20).optional(),
    clienteNombre: z.string().trim().min(3).max(200),
    clientePais: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((p) => p.toUpperCase()).optional(),
    clienteEmail: z.string().trim().email().max(191).optional(),
    nota: z.string().trim().max(255).optional(),
  })
  .superRefine((d, ctx) => {
    const doc = d.clienteNumDoc ?? '';
    if (d.clienteTipoDoc === '1' && !/^\d{8}$/.test(doc)) {
      ctx.addIssue({ code: 'custom', path: ['clienteNumDoc'], message: 'El DNI tiene 8 dígitos.' });
    }
    if ((d.clienteTipoDoc === '4' || d.clienteTipoDoc === '7') && !/^[A-Za-z0-9]{6,12}$/.test(doc)) {
      ctx.addIssue({ code: 'custom', path: ['clienteNumDoc'], message: 'El documento tiene de 6 a 12 letras o números.' });
    }
    if (d.clienteTipoDoc === '0' && !d.clientePais) {
      ctx.addIssue({ code: 'custom', path: ['clientePais'], message: 'Falta el país del cliente extranjero.' });
    }
  });
const mesSchema = z.object({
  anio: z.coerce.number().int().min(2026).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
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
  '/de-venta',
  soloAdmin,
  validate({ query: z.object({ canal: z.enum(['codigo', 'pago']), id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => ok(res, await sunatService.deVenta(req.query.canal, req.query.id))),
);

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

router.get(
  '/servicios',
  soloAdmin,
  validate({ query: mesSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { servicios: await sunatService.serviciosDelMes(req.query.anio, req.query.mes) }),
  ),
);

router.post(
  '/servicios',
  soloAdmin,
  validate({ body: servicioSchema }),
  asyncHandler(async (req, res) => ok(res, { servicio: await sunatService.registrarServicio(req.body, req.user.id) })),
);

router.delete(
  '/servicios/:id',
  soloAdmin,
  validate({ params: idSchema }),
  asyncHandler(async (req, res) => {
    await sunatService.quitarServicio(req.params.id);
    return ok(res, { quitado: true });
  }),
);

module.exports = router;
