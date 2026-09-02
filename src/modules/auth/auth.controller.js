'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { setRefreshCookie, clearRefreshCookie, readRefreshCookie } = require('../../shared/utils/cookies');
const { extractContext } = require('../../shared/utils/requestContext');
const authService = require('./auth.service');

const authController = {
  register: asyncHandler(async (req, res) => {
    const user = await authService.register(req.body);
    return created(
      res,
      { user },
      'Cuenta creada. Revisa tu correo para confirmar tu dirección.',
    );
  }),

  login: asyncHandler(async (req, res) => {
    const { user, accessToken, refreshToken, refreshExpiresAt } = await authService.login(
      req.body,
      extractContext(req),
    );

    // El refresh viaja solo en cookie httpOnly; el access, en el cuerpo,
    // para que el frontend lo guarde en memoria y no en localStorage.
    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    return ok(res, { user, accessToken }, { message: 'Sesión iniciada.' });
  }),

  refresh: asyncHandler(async (req, res) => {
    const { accessToken, refreshToken, refreshExpiresAt } = await authService.refresh(
      readRefreshCookie(req),
      extractContext(req),
    );

    setRefreshCookie(res, refreshToken, refreshExpiresAt);
    return ok(res, { accessToken });
  }),

  logout: asyncHandler(async (req, res) => {
    await authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    return noContent(res);
  }),

  logoutAll: asyncHandler(async (req, res) => {
    await authService.logoutAll(req.user.id);
    clearRefreshCookie(res);
    return noContent(res);
  }),

  verifyEmail: asyncHandler(async (req, res) => {
    const user = await authService.verifyEmail(req.body.token);
    return ok(res, { user }, { message: 'Correo confirmado. Ya puedes iniciar sesión.' });
  }),

  resendVerification: asyncHandler(async (req, res) => {
    await authService.resendVerification(req.body.email);
    return ok(res, null, {
      message: 'Si el correo está registrado y pendiente de confirmar, recibirás un mensaje.',
    });
  }),
};

module.exports = authController;
