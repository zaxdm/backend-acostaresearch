'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const asistenteService = require('./asistente.service');

const asistenteController = {
  /** Si el panel se enseña. Sin clave de Gemini, la web no lo pinta. */
  estado: (_req, res) => ok(res, asistenteService.estado()),

  mensaje: asyncHandler(async (req, res) => {
    return ok(res, await asistenteService.responder(req.body));
  }),
};

module.exports = asistenteController;
