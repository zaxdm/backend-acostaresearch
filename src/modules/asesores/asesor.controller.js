'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const asesorService = require('./asesor.service');

const asesorController = {
  // ── Público ────────────────────────────────────────────────────────────

  /** Lo que se enseña a quien abre el enlace de la convocatoria. */
  verConvocatoria: asyncHandler(async (req, res) => {
    return ok(res, { convocatoria: await asesorService.verConvocatoria(req.params.slug) });
  }),

  /**
   * La convocatoria pública, si alguna lo es.
   *
   * Nula mientras el registro esté cerrado, y la web trata esa respuesta como
   * «esta página no existe». Devuelve 200 y no 404 porque no es un error: es
   * la respuesta correcta a «¿hay algo abierto?».
   */
  publica: asyncHandler(async (_req, res) => {
    return ok(res, { convocatoria: await asesorService.convocatoriaPublica() });
  }),

  postular: asyncHandler(async (req, res) => {
    const asesor = await asesorService.postular(req.params.slug, req.body);
    // Se le devuelve solo lo que confirma que llegó. Su ficha entera vive en
    // el panel, que es quien la va a leer.
    return created(
      res,
      { recibida: true, nombre: asesor.nombre },
      'Ficha recibida. Te escribimos al correo cuando la revisemos.',
    );
  }),

  // ── Administrador ──────────────────────────────────────────────────────

  listar: asyncHandler(async (_req, res) => {
    return ok(res, { asesores: await asesorService.listar() });
  }),

  revisar: asyncHandler(async (req, res) => {
    const asesor = await asesorService.revisar(req.params.id, req.body, req.user.id);
    const dicho = { PENDIENTE: 'devuelta a pendiente', APROBADO: 'aprobada', RECHAZADO: 'rechazada' };
    return ok(res, { asesor }, { message: `Ficha de ${asesor.nombre} ${dicho[asesor.estado]}.` });
  }),

  convocatorias: asyncHandler(async (_req, res) => {
    return ok(res, { convocatorias: await asesorService.listarConvocatorias() });
  }),

  crearConvocatoria: asyncHandler(async (req, res) => {
    const convocatoria = await asesorService.crearConvocatoria(req.body, req.user.id);
    return created(res, { convocatoria }, 'Convocatoria creada. Reparte su enlace a mano.');
  }),

  cambiarConvocatoria: asyncHandler(async (req, res) => {
    const convocatoria = await asesorService.cambiarConvocatoria(req.params.id, req.body);
    const message = convocatoria.publica
      ? 'Convocatoria pública: ahora se llega sin el enlace.'
      : 'Convocatoria guardada. Solo se llega con el enlace.';
    return ok(res, { convocatoria }, { message });
  }),
};

module.exports = asesorController;
