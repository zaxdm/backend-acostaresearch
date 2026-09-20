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
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');
const { enBeta } = require('./beta');
const { catalogos: catalogosDelPedido } = require('./pedido.catalogo');
const {
  pedidoQuerySchema,
  codigoParamSchema,
  slugParamSchema,
  idParamSchema,
  tokenParamSchema,
  entregaSchema,
  rechazoSchema,
  disponibilidadSchema,
  reasignarSchema,
  resenaSchema,
  pedidoPatchSchema,
} = require('./pedido.schema');
const { convocatoriaSchema, convocatoriaCambioSchema } = require('../asesores/asesor.schema');
const pedidoService = require('./pedido.service');

const router = express.Router();

/**
 * Tres puertas y ninguna con cuenta.
 *
 * El tesista entra por el enlace de la convocatoria y vuelve con su código. El
 * asesor entra por su enlace privado. La casa, con sesión de administrador,
 * solo para mirar y para parar algo que se torció.
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

/** Baja un archivo de disco con su nombre, sin tragarse un 404 de verdad. */
function enviarArchivo(res, next, { ruta, nombre }) {
  res.attachment(nombre);
  res.sendFile(ruta, (error) => {
    if (error) next(error.status === 404 ? undefined : error);
  });
}

// ── El tesista ─────────────────────────────────────────────────────────────
// Sin sesión: llega desde un enlace de WhatsApp y no se le va a pedir que se
// registre para elegir asesor y dejar su capítulo.

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

/** El directorio: entre quiénes elige. Lo primero que ve al abrir el enlace. */
router.get(
  '/convocatoria/:slug/asesores',
  validate({ params: slugParamSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { asesores: await pedidoService.directorio(req.params.slug) }),
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
    return created(
      res,
      { codigo: pedido.codigo },
      'Se lo mandamos a tu asesor. Guarda tu código para seguir cómo va.',
    );
  }),
);

// ── El asesor, por su enlace privado ───────────────────────────────────────
// Va antes que `/:codigo` para que «asesor» se lea como lo que es y no como un
// código de pedido.

router.get(
  '/asesor/:token',
  validate({ params: tokenParamSchema }),
  asyncHandler(async (req, res) => ok(res, await pedidoService.panelDelAsesor(req.params.token))),
);

/** Apagarse cuando está lleno, sin que nadie tenga que rechazarlo. */
router.patch(
  '/asesor/:token',
  validate({ params: tokenParamSchema, body: disponibilidadSchema }),
  asyncHandler(async (req, res) => {
    const panel = await pedidoService.cambiarDisponibilidad(req.params.token, req.body.visible);
    const message = req.body.visible
      ? 'Vuelves a salir en el directorio.'
      : 'Ya no sales en el directorio. No te llegarán encargos nuevos.';
    return ok(res, panel, { message });
  }),
);

router.post(
  '/asesor/:token/:id/aceptar',
  validate({ params: tokenParamSchema.merge(idParamSchema) }),
  asyncHandler(async (req, res) => {
    const encargo = await pedidoService.aceptar(req.params.token, req.params.id);
    return ok(res, { encargo }, { message: 'Aceptado. Ya puedes abrir el documento.' });
  }),
);

router.post(
  '/asesor/:token/:id/rechazar',
  validate({ params: tokenParamSchema.merge(idParamSchema), body: rechazoSchema }),
  asyncHandler(async (req, res) => {
    const encargo = await pedidoService.rechazar(req.params.token, req.params.id, req.body.motivo);
    return ok(res, { encargo }, { message: 'Rechazado. El tesista podrá elegir a otro.' });
  }),
);

router.post(
  '/asesor/:token/:id/entregar',
  validate({ params: tokenParamSchema.merge(idParamSchema), body: entregaSchema }),
  asyncHandler(async (req, res) => {
    const encargo = await pedidoService.entregar(
      req.params.token,
      req.params.id,
      req.body.enlaceObservaciones,
    );
    return ok(res, { encargo }, { message: 'Entregado. El tesista ya puede leer tus observaciones.' });
  }),
);

/**
 * El documento del encargo.
 *
 * El servicio comprueba que lo haya aceptado: si dependiera de que el botón no
 * se dibuje, bastaría con adivinar la dirección para leer una tesis sin haberse
 * comprometido a revisarla.
 */
router.get(
  '/asesor/:token/:id/documento',
  validate({ params: tokenParamSchema.merge(idParamSchema) }),
  asyncHandler(async (req, res, next) =>
    enviarArchivo(
      res,
      next,
      await pedidoService.documentoParaAsesor(req.params.token, req.params.id),
    ),
  ),
);

// ── Desde su panel, con su cuenta ──────────────────────────────────────────
//
// Van ANTES de `/:codigo`, que es un comodín de un segmento y se los tragaría.
// Llevan sesión pero no rol de administrador: es el comprador mirando lo suyo.
//
// Y llevan `enBeta`, que es lo que mantiene esto invisible para los demás
// mientras se prueba. Ver `modules/pedidos/beta`.

/**
 * Si lo ve y, si lo ve, sus revisiones.
 *
 * Contesta 200 con `beta: false` a quien no está en la lista, en vez de 403: no
 * es que no tenga permiso para algo, es que para él eso no existe. Su panel lee
 * ese falso y no pinta nada.
 */
router.get(
  '/mis-revisiones',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!enBeta(req.user.email)) return ok(res, { beta: false, pedidos: [], catalogos: null });
    // Los catálogos viajan aquí y no se piden aparte: su panel no tiene enlace
    // de convocatoria del que sacarlos, y sin ellos los desplegables del
    // formulario saldrían vacíos.
    return ok(res, {
      beta: true,
      pedidos: await pedidoService.misPedidos(req.user.email),
      catalogos: catalogosDelPedido(),
    });
  }),
);

/** El directorio, sin enlace de convocatoria: ya entró con su cuenta. */
router.get(
  '/mis-revisiones/asesores',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!enBeta(req.user.email)) throw new NotFoundError('No encontramos esa página.');
    return ok(res, { asesores: await pedidoService.directorioDelPanel() });
  }),
);

router.post(
  '/mis-revisiones',
  authenticate,
  pedidoLimiter,
  documento,
  asyncHandler(async (req, res) => {
    if (!enBeta(req.user.email)) throw new NotFoundError('No encontramos esa página.');

    const datos = pedidoQuerySchema.safeParse(req.query);
    if (!datos.success) {
      throw new ValidationError(datos.error.issues[0]?.message ?? 'Revisa los datos del formulario.');
    }

    // El correo es el de su cuenta y no el que venga en la petición: es la
    // llave con la que después encuentra lo suyo, y mandar en nombre de otro
    // no puede depender de lo que escriba el navegador.
    const pedido = await pedidoService.crearDesdeSuPanel(
      { ...datos.data, email: req.user.email },
      req.body,
      nombreSubido(req),
    );
    return created(res, { codigo: pedido.codigo }, 'Se lo mandamos a tu asesor.');
  }),
);

// ── El seguimiento del tesista ─────────────────────────────────────────────
// Debajo de todo lo anterior porque `/:codigo` es un comodín de un segmento.

router.get(
  '/:codigo',
  validate({ params: codigoParamSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { pedido: await pedidoService.seguimiento(req.params.codigo) }),
  ),
);

/** Entre quiénes puede elegir si le dijeron que no. Sin el que lo rechazó. */
router.get(
  '/:codigo/asesores',
  validate({ params: codigoParamSchema }),
  asyncHandler(async (req, res) =>
    ok(res, { asesores: await pedidoService.directorioParaPedido(req.params.codigo) }),
  ),
);

/** Su asesor no pudo: elige otro sin volver a subir el documento. */
router.post(
  '/:codigo/asesor',
  pedidoLimiter,
  validate({ params: codigoParamSchema, body: reasignarSchema }),
  asyncHandler(async (req, res) => {
    const pedido = await pedidoService.reasignar(req.params.codigo, req.body.asesorId);
    return ok(res, { pedido }, { message: 'Listo, se lo mandamos a tu nuevo asesor.' });
  }),
);

router.post(
  '/:codigo/resena',
  pedidoLimiter,
  validate({ params: codigoParamSchema, body: resenaSchema }),
  asyncHandler(async (req, res) => {
    const pedido = await pedidoService.resenar(req.params.codigo, req.body);
    return created(res, { pedido }, 'Gracias. Tu opinión ayuda al siguiente tesista a elegir.');
  }),
);

// ── La casa ────────────────────────────────────────────────────────────────
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
  asyncHandler(async (req, res, next) =>
    enviarArchivo(res, next, await pedidoService.paraDescargar(req.params.id)),
  ),
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
