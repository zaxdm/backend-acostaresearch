'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const tutorialService = require('./tutorial.service');

const tutorialController = {
  /** Público: es lo que pinta la página de tutoriales. */
  list: asyncHandler(async (_req, res) => {
    return ok(res, { tutoriales: await tutorialService.listPublic() });
  }),

  /**
   * Qué productos compró quien pregunta: la web le enseña solo esos videos y
   * esas guías. El administrador los ve todos (`todos`), que es quien los sube.
   */
  misProductos: asyncHandler(async (req, res) => {
    if (req.user.role === ROLES.ADMIN) return ok(res, { todos: true, productos: [] });
    return ok(res, { todos: false, productos: await tutorialService.productosDe(req.user.id) });
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

  /** Arrastrar en el panel: devuelve la lista ya numerada. */
  reorder: asyncHandler(async (req, res) => {
    const tutoriales = await tutorialService.reorder(req.body.ids);
    return ok(res, { tutoriales }, { message: 'Orden guardado. Ya se ve así en la web.' });
  }),

  /** Al pegar el enlace en el panel: el título del video, para no escribirlo. */
  youtube: asyncHandler(async (req, res) => {
    return ok(res, await tutorialService.datosDeYouTube(req.params.videoId));
  }),

  /** «De qué va» y los puntos, escritos por la IA viendo el video. */
  resumen: asyncHandler(async (req, res) => {
    return ok(res, await tutorialService.resumenDeYouTube(req.params.videoId));
  }),

  remove: asyncHandler(async (req, res) => {
    await tutorialService.remove(req.params.id);
    return noContent(res);
  }),
};

module.exports = tutorialController;
