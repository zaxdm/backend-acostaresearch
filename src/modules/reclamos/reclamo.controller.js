'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const reclamoService = require('./reclamo.service');

const reclamoController = {
  /** Público: los datos del proveedor que encabezan la hoja. */
  proveedor: asyncHandler(async (_req, res) => {
    return ok(res, { proveedor: reclamoService.proveedor() });
  }),

  /** Público: cualquiera puede reclamar, compre o no, y sin cuenta. */
  registrar: asyncHandler(async (req, res) => {
    const { reclamo, correoEnviado } = await reclamoService.registrar(req.body);
    // Se le devuelve su propia hoja, que es lo que imprime. Quién respondió es
    // cosa del panel.
    const { respondidoPorId: _interno, ...hoja } = reclamo;
    return created(res, { reclamo: hoja, correoEnviado }, `Hoja Nº ${reclamo.codigo} registrada.`);
  }),

  listar: asyncHandler(async (_req, res) => {
    return ok(res, { reclamos: await reclamoService.listar() });
  }),

  responder: asyncHandler(async (req, res) => {
    const { reclamo, correoEnviado } = await reclamoService.responder(
      req.params.numero,
      req.body.respuesta,
      req.user.id,
    );
    const message = correoEnviado
      ? `Hoja Nº ${reclamo.codigo} respondida. La respuesta salió por correo.`
      : `Hoja Nº ${reclamo.codigo} respondida, pero el correo no salió: avísale por otra vía.`;
    return ok(res, { reclamo, correoEnviado }, { message });
  }),
};

module.exports = reclamoController;
