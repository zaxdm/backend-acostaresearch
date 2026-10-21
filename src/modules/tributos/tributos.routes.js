'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const tributosService = require('./tributos.service');

/** La declaración mensual del 621 en el panel. Solo ADMIN. */
const router = Router();

const mesSchema = z.object({
  anio: z.coerce.number().int().min(2026).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
});
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha con formato aaaa-mm-dd');
const centimos = z.number().int().min(0).max(1_000_000_000);

const actualizarSchema = z.object({
  vencimiento: fecha.nullable().optional(),
  ajusteBaseCents: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
  ajusteNota: z.string().trim().max(255).nullable().optional(),
  saldoFavorInicialCents: centimos.nullable().optional(),
});

const declararSchema = z.object({
  numeroOrden: z.string().trim().max(30).optional(),
  igvPagadoCents: centimos.nullable().optional(),
  rentaPagadaCents: centimos.nullable().optional(),
});

const facturaSchema = z.object({
  tipo: z.literal('FACTURA').default('FACTURA'),
  fecha,
  rucProveedor: z.string().regex(/^\d{11}$/, 'El RUC tiene 11 dígitos'),
  razonSocial: z.string().trim().max(200).optional(),
  serie: z.string().trim().regex(/^[A-Za-z0-9]{4}$/, 'La serie tiene 4 caracteres'),
  numero: z.number().int().min(1).max(99_999_999),
  baseCents: centimos,
  igvCents: centimos,
  descripcion: z.string().trim().max(200).optional(),
});

/**
 * Un servicio de un proveedor del extranjero (Claude, Google, Canva…). En
 * dólares, con el tipo de cambio venta de SUNAT del día del pago. El IGV se
 * propone al 18 % si no viene. Si ya se pagó con el 1662, su orden y su día.
 */
const extranjeraSchema = z
  .object({
    tipo: z.literal('EXTRANJERO'),
    fecha,
    razonSocial: z.string().trim().min(2).max(200),
    documento: z.string().trim().min(1).max(60),
    monedaOriginal: z.enum(['USD', 'PEN']),
    importeOriginalCents: centimos.refine((c) => c > 0, 'Escribe el monto'),
    tipoCambio: z.number().positive().max(99).optional(),
    igvCents: centimos.optional(),
    ordenPago: z.string().trim().max(30).optional(),
    igvPagadoEn: fecha.optional(),
    descripcion: z.string().trim().max(200).optional(),
  })
  .refine((d) => d.monedaOriginal !== 'USD' || d.tipoCambio, {
    path: ['tipoCambio'],
    message: 'Falta el tipo de cambio del día del pago',
  });

const compraSchema = z.union([extranjeraSchema, facturaSchema]);

const pago1662Schema = z.object({
  ordenPago: z.string().trim().max(30).optional(),
  fecha,
  igvCents: centimos.optional(),
});

const periodo = (req) => ({ anio: Number(req.params.anio), mes: Number(req.params.mes) });

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/meses', asyncHandler(async (_req, res) => ok(res, { meses: await tributosService.meses() })));

router.get(
  '/meses/:anio/:mes',
  validate({ params: mesSchema }),
  asyncHandler(async (req, res) => ok(res, await tributosService.detalle(periodo(req)))),
);

router.patch(
  '/meses/:anio/:mes',
  validate({ params: mesSchema, body: actualizarSchema }),
  asyncHandler(async (req, res) => ok(res, await tributosService.actualizar(periodo(req), req.body))),
);

router.post(
  '/meses/:anio/:mes/declarar',
  validate({ params: mesSchema, body: declararSchema }),
  asyncHandler(async (req, res) => ok(res, await tributosService.declarar(periodo(req), req.body))),
);

router.post(
  '/meses/:anio/:mes/reabrir',
  validate({ params: mesSchema }),
  asyncHandler(async (req, res) => ok(res, await tributosService.reabrir(periodo(req)))),
);

router.post(
  '/compras',
  validate({ body: compraSchema }),
  asyncHandler(async (req, res) => ok(res, { compra: await tributosService.agregarCompra(req.body, req.user.id) })),
);

router.post(
  '/compras/:id/pago-1662',
  validate({ params: z.object({ id: z.string().uuid() }), body: pago1662Schema }),
  asyncHandler(async (req, res) =>
    ok(res, { compra: await tributosService.pagarIgvDeExtranjera(req.params.id, req.body) }),
  ),
);

router.delete(
  '/compras/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    await tributosService.borrarCompra(req.params.id);
    return ok(res, { borrada: true });
  }),
);

module.exports = router;
