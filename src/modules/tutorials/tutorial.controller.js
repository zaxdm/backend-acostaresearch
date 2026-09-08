'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const tutorialService = require('./tutorial.service');

const tutorialController = {
  /** Público: es lo que pinta la página de tutoriales. */
  list: asyncHandler(async (_req, res) => {
    return ok(res, { tutoriales: await tutorialService.listPublic() });
  }),

  listAll: asyncHandler(async (_req, res) => {
    return ok(res, { tutoriales: await tutorialService.listAll() });
  }),

  create: asyncHandler(async (req, res) => {
    const tutorial = await tutorialService.create(req.body);
    return created(res, { tutorial }, `«${tutorial.titulo}» creado.`);
  }),

  update: asyncHandler(async (req, res) => {
    const tutorial = await tutorialService.update(req.params.id, req.body);
    const mensaje = tutorial.videoUrl
      ? `«${tutorial.titulo}» actualizado. Ya se ve en la web.`
      : `«${tutorial.titulo}» actualizado. Sigue sin video: la tarjeta lo dice.`;
    return ok(res, { tutorial }, { message: mensaje });
  }),

  remove: asyncHandler(async (req, res) => {
    await tutorialService.remove(req.params.id);
    return noContent(res);
  }),
};

module.exports = tutorialController;
