'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { addDays } = require('../../shared/utils/tokens');
const licenseService = require('./license.service');

const licenseController = {
  /** Solo ADMIN. Los códigos en claro se devuelven aquí y nunca más. */
  generate: asyncHandler(async (req, res) => {
    const { expiraEnDias, ...resto } = req.body;

    const resultado = await licenseService.generateCodes({
      ...resto,
      createdById: req.user.id,
      expiresAt: expiraEnDias ? addDays(new Date(), expiraEnDias) : undefined,
    });

    return created(
      res,
      resultado,
      'Códigos generados. Cópialos ahora: no se pueden volver a consultar.',
    );
  }),

  codes: asyncHandler(async (req, res) => {
    const codes = await licenseService.listCodes(req.query);
    return ok(res, { codes });
  }),

  voidCode: asyncHandler(async (req, res) => {
    await licenseService.voidCode(req.params.id);
    return noContent(res);
  }),

  /** El comprador canjea su código estando dentro de su cuenta. */
  redeem: asyncHandler(async (req, res) => {
    const resultado = await licenseService.redeemCode({
      userId: req.user.id,
      code: req.body.code,
    });
    return created(res, resultado, 'Licencia activada. Pega la URL en Claude para empezar.');
  }),

  /** Vuelve a generar la URL del conector. La anterior deja de servir. */
  rotate: asyncHandler(async (req, res) => {
    const resultado = await licenseService.rotate({
      licenseId: req.params.id,
      userId: req.user.id,
    });
    return ok(res, resultado, {
      message: 'URL nueva generada. La anterior ya no funciona: actualízala en Claude.',
    });
  }),

  mine: asyncHandler(async (req, res) => {
    const licenses = await licenseService.listForUser(req.user.id);
    return ok(res, { licenses });
  }),

  list: asyncHandler(async (req, res) => {
    const licenses = await licenseService.listAll(req.query);
    return ok(res, { licenses });
  }),

  inspect: asyncHandler(async (req, res) => {
    const ficha = await licenseService.inspect(req.params.id);
    return ok(res, ficha);
  }),

  /** Alertas abiertas de todas las licencias: la bandeja del administrador. */
  alerts: asyncHandler(async (_req, res) => {
    const alerts = await licenseService.openAlerts();
    return ok(res, { alerts });
  }),

  /** Repaso de todas las licencias activas en busca de patrones raros. */
  review: asyncHandler(async (_req, res) => {
    const hallazgos = await licenseService.review();
    return ok(res, { hallazgos });
  }),

  revoke: asyncHandler(async (req, res) => {
    const license = await licenseService.revoke(req.params.id, req.body.reason);
    return ok(res, { license }, { message: 'Licencia revocada.' });
  }),

  reactivate: asyncHandler(async (req, res) => {
    const license = await licenseService.reactivate(req.params.id);
    return ok(res, { license }, { message: 'Licencia reactivada.' });
  }),
};

module.exports = licenseController;
