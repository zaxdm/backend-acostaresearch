'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const sorteoService = require('./sorteo.service');

const sorteoController = {
  /** Público: lo que ve quien abre el enlace. */
  verPublico: asyncHandler(async (req, res) => {
    return ok(res, await sorteoService.verPublico(req.params.slug));
  }),

  /** Público: apuntarse con el correo, sin cuenta. */
  inscribir: asyncHandler(async (req, res) => {
    const data = await sorteoService.inscribir(req.params.slug, req.body);
    return created(res, data, '¡Listo! Ya estás participando en el sorteo.');
  }),

  listar: asyncHandler(async (_req, res) => {
    return ok(res, { sorteos: await sorteoService.listar() });
  }),

  ver: asyncHandler(async (req, res) => {
    return ok(res, { sorteo: await sorteoService.ver(req.params.id) });
  }),

  crear: asyncHandler(async (req, res) => {
    const sorteo = await sorteoService.crear(req.body, req.user.id);
    return created(res, { sorteo }, 'Sorteo creado. Comparte el enlace.');
  }),

  cambiar: asyncHandler(async (req, res) => {
    return ok(res, { sorteo: await sorteoService.cambiar(req.params.id, req.body) });
  }),

  quitarParticipante: asyncHandler(async (req, res) => {
    const sorteo = await sorteoService.quitarParticipante(req.params.id, req.params.participanteId);
    return ok(res, { sorteo });
  }),

  borrar: asyncHandler(async (req, res) => {
    await sorteoService.borrar(req.params.id);
    return noContent(res);
  }),

  sortear: asyncHandler(async (req, res) => {
    const resultado = await sorteoService.sortear(req.params.id, req.user.id);
    const message = resultado.correoEnviado
      ? `Ganó ${resultado.ganador.email}. Ya le mandamos su código por correo.`
      : `Ganó ${resultado.ganador.email}, pero el correo no salió: mándale el código por otra vía.`;
    return ok(res, resultado, { message });
  }),
};

module.exports = sorteoController;
