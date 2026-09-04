'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const skillService = require('./skill.service');

const skillController = {
  /** Público: es lo que muestra la portada. Nombre y resumen, nada más. */
  catalog: asyncHandler(async (_req, res) => {
    const skills = await skillService.listCatalog();
    return ok(res, { skills });
  }),

  list: asyncHandler(async (_req, res) => {
    const skills = await skillService.listAll();
    return ok(res, { skills });
  }),

  /** Comprueba el bundle sin guardarlo, para poder avisar antes de reemplazar. */
  inspect: asyncHandler(async (req, res) => {
    const analisis = await skillService.inspectBundle(req.body);
    return ok(res, analisis);
  }),

  upload: asyncHandler(async (req, res) => {
    const { skill, tramos, creada } = await skillService.upsertFromBundle({
      buffer: req.body,
      ...req.query,
    });

    const mensaje = creada
      ? `«${skill.displayName}» ya está disponible en el conector: ${tramos} tramos.`
      : `«${skill.displayName}» se actualizó: ${tramos} tramos. Los tesistas lo ven al instante.`;

    return creada
      ? created(res, { skill, tramos }, mensaje)
      : ok(res, { skill, tramos }, { message: mensaje });
  }),

  update: asyncHandler(async (req, res) => {
    const skill = await skillService.updateMeta(req.params.id, req.body);
    return ok(res, { skill }, { message: 'Ficha actualizada.' });
  }),

  remove: asyncHandler(async (req, res) => {
    await skillService.remove(req.params.id);
    return noContent(res);
  }),
};

module.exports = skillController;
