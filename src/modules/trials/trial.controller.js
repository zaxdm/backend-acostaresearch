'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const trialService = require('./trial.service');

const trialController = {
  list: asyncHandler(async (_req, res) => {
    return ok(res, { enlaces: await trialService.list() });
  }),

  create: asyncHandler(async (req, res) => {
    const enlace = await trialService.create({ ...req.body, createdById: req.user.id });
    return created(res, { enlace }, `Enlace «${enlace.name}» creado con ${enlace.seats} cupos.`);
  }),

  update: asyncHandler(async (req, res) => {
    const enlace = await trialService.setActive(req.params.id, req.body.active);
    const mensaje = enlace.active
      ? `«${enlace.name}» encendido: sus conectores vuelven a funcionar.`
      : `«${enlace.name}» apagado: todos sus conectores quedaron cortados.`;
    return ok(res, { enlace }, { message: mensaje });
  }),

  remove: asyncHandler(async (req, res) => {
    const { name } = await trialService.remove(req.params.id);
    return ok(res, { id: req.params.id }, { message: `«${name}» borrado con sus conectores.` });
  }),

  guests: asyncHandler(async (req, res) => {
    return ok(res, { invitados: await trialService.guests(req.params.id) });
  }),

  /** Público: lo que ve quien abre el enlace. */
  publicInfo: asyncHandler(async (req, res) => {
    return ok(res, { prueba: await trialService.publicInfo(req.params.slug) });
  }),

  /** Público: entrega un conector. La URL solo existe en esta respuesta. */
  claim: asyncHandler(async (req, res) => {
    const entrega = await trialService.claim(req.params.slug);
    return created(res, entrega, 'Tu conector de prueba está listo.');
  }),
};

module.exports = trialController;
