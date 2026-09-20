'use strict';

const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const { pedidoLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const env = require('../../config/env');
const { ValidationError } = require('../../shared/errors/AppError');
const {
  pedidoQuerySchema,
  codigoParamSchema,
  slugParamSchema,
  idParamSchema,
  pedidoPatchSchema,
} = require('./pedido.schema');
const { convocatoriaSchema, convocatoriaCambioSchema } = require('../asesores/asesor.schema');
const pedidoService = require('./pedido.service');

const router = express.Router();

/**
 * El Word va en crudo con su ficha en la query, como el PDF de las guías: es un
 * solo archivo y `multipart` añadiría una dependencia para obtener lo mismo.
 */
const documento = express.raw({ type: () => true, limit: env.PEDIDO_MAX_BYTES });

/** El nombre con el que se subió va en una cabecera: la query lleva la ficha. */
function nombreSubido(req) {
  try {
    return decodeURIComponent(req.get('X-Nombre-Archivo') ?? '');
  } catch {
    return '';
  }
}

// ── Público ────────────────────────────────────────────────────────────────
// Sin sesión a propósito: el tesista llega desde un enlace de WhatsApp y no se
// le va a pedir que se registre para dejar su capítulo.

router.get(
  '/convocatoria/publica',
  asyncHandler(async (_req, res) =>
    ok(res, { convocatoria: await pedidoService.convocatoriaPublica() }),
  ),
);

router.get(
  '/convocatoria/:slug',
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { convocatoria: await pedidoService.verConvocatoria(req.params.slug) }),
  ),
);

router.post(
  '/convocatoria/:slug',
  pedidoLimiter,
  validate({ params: slugParamSchema }),
  documento,
  asyncHandler(async (req, res) => {
    const datos = pedidoQuerySchema.safeParse(req.query);
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Revisa los datos del formulario.');
    }

    const pedido = await pedidoService.crear(
      req.params.slug,
      datos.data,
      req.body,
      nombreSubido(req),
    );
    // Se le devuelve su código y nada más: el resto lo consulta en su
    // seguimiento, que es donde va a volver a mirar.
    return created(
      res,
      { codigo: pedido.codigo },
      'Recibimos tu trabajo. Guarda tu código para seguir cómo va.',
    );
  }),
);

/** El seguimiento. El código es la llave, como los enlaces que da el conector. */
router.get(
  '/:codigo',
  validate({ params: codigoParamSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { pedido: await pedidoService.seguimiento(req.params.codigo) }),
  ),
);

// ── Administración ─────────────────────────────────────────────────────────
router.use(authenticate, authorize(ROLES.ADMIN));

router.get(
  '/admin/convocatorias',
  asyncHandler(async (_req, res) =>
    ok(res, { convocatorias: await pedidoService.listarConvocatorias() }),
  ),
);

router.post(
  '/admin/convocatorias',
  validate({ body: convocatoriaSchema }),
  asyncHandler(async (req, res) => {
    const convocatoria = await pedidoService.crearConvocatoria(req.body, req.user.id);
    return created(res, { convocatoria }, 'Enlace creado. Repártelo a mano.');
  }),
);

router.patch(
  '/admin/convocatorias/:id',
  validate({ params: idParamSchema, body: convocatoriaCambioSchema }),
  asyncHandler(async (req, res) => {
    const convocatoria = await pedidoService.cambiarConvocatoria(req.params.id, req.body);
    const message = convocatoria.publica
      ? 'Formulario público: ahora se llega sin el enlace.'
      : 'Guardado. Solo se llega con el enlace.';
    return ok(res, { convocatoria }, { message });
  }),
);

router.get(
  '/admin/todos',
  asyncHandler(async (_req, res) => ok(res, { pedidos: await pedidoService.listar() })),
);

router.get(
  '/admin/:id/documento',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res, next) => {
    const { ruta, nombre } = await pedidoService.paraDescargar(req.params.id);
    res.attachment(nombre);
    res.sendFile(ruta, (error) => {
      // Ficha sin archivo en disco: que caiga en el 404 normal y quede en el log.
      if (error) next(error.status === 404 ? undefined : error);
    });
  }),
);

router.patch(
  '/admin/:id',
  validate({ params: idParamSchema, body: pedidoPatchSchema }),
  asyncHandler(async (req, res) => {
    const pedido = await pedidoService.cambiar(req.params.id, req.body);
    return ok(res, { pedido }, { message: `Pedido ${pedido.codigo} guardado.` });
  }),
);

module.exports = router;
