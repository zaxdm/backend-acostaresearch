'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const { readRefreshCookie } = require('../../shared/utils/cookies');
const userService = require('./user.service');

const userController = {
  me: asyncHandler(async (req, res) => {
    const user = await userService.getProfile(req.user.id);
    return ok(res, { user });
  }),

  updateMe: asyncHandler(async (req, res) => {
    const user = await userService.updateProfile(req.user.id, req.body);
    return ok(res, { user }, { message: 'Datos guardados.' });
  }),

  requestPasswordCode: asyncHandler(async (req, res) => {
    const { email, expiresInMinutes } = await userService.requestPasswordCode(req.user.id);
    return ok(
      res,
      { email, expiresInMinutes },
      { message: `Te enviamos un código a ${email}. Caduca en ${expiresInMinutes} minutos.` },
    );
  }),

  changePassword: asyncHandler(async (req, res) => {
    // La cookie identifica la sesión desde la que se pide el cambio, que es la
    // única que sobrevive: a las demás se las echa.
    const { sesionesCerradas } = await userService.changePassword(
      req.user.id,
      req.body,
      readRefreshCookie(req),
    );

    return ok(
      res,
      { sesionesCerradas },
      {
        message:
          sesionesCerradas > 0
            ? `Contraseña cambiada. Se cerraron ${sesionesCerradas} ${
                sesionesCerradas === 1 ? 'sesión abierta' : 'sesiones abiertas'
              } en otros dispositivos.`
            : 'Contraseña cambiada.',
      },
    );
  }),

  createAdmin: asyncHandler(async (req, res) => {
    const resultado = await userService.createAdmin(req.body, req.user.id);
    return created(res, resultado, 'Cuenta de administrador creada.');
  }),

  list: asyncHandler(async (req, res) => {
    const { items, meta } = await userService.list(req.query);
    return ok(res, { users: items, meta });
  }),
};

module.exports = userController;
