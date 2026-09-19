'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const servicio = require('./mapas.service');

const mapasController = {
  coocurrencia: asyncHandler(async (req, res) => {
    return ok(res, await servicio.coocurrencia(req.user.id, req.body));
  }),
};

module.exports = mapasController;
