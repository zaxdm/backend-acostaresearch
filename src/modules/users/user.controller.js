'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { readRefreshCookie, clearRefreshCookie } = require('../../shared/utils/cookies');
const { dondePais } = require('../../middlewares/panelDePais');
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

  deleteMe: asyncHandler(async (req, res) => {
    await userService.deleteOwnAccount(req.user.id, req.body);
    // La cookie se limpia aquí: la sesión que acaba de borrar su cuenta no puede
    // quedarse con un refresh token en el navegador apuntando a nada.
    clearRefreshCookie(res);
    return noContent(res);
  }),

  createAdmin: asyncHandler(async (req, res) => {
    const resultado = await userService.createAdmin(req.body, req.user.id);
    return created(res, resultado, 'Cuenta de administrador creada.');
  }),

  cambiarEstado: asyncHandler(async (req, res) => {
    const { user, cambiado } = await userService.cambiarEstadoPorAdmin({
      userId: req.params.id,
      status: req.body.status,
      adminId: req.user.id,
    });
    const suspendida = user.status === 'SUSPENDED';
    return ok(
      res,
      { user },
      {
        message: !cambiado
          ? `La cuenta ya estaba ${suspendida ? 'suspendida' : 'activa'}.`
          : suspendida
            ? 'Cuenta suspendida. Sus sesiones y su conector dejan de funcionar ahora.'
            : 'Cuenta reactivada. Tiene que volver a iniciar sesión.',
      },
    );
  }),

  cambiarRol: asyncHandler(async (req, res) => {
    const { user, cambiado } = await userService.cambiarRolPorAdmin({
      userId: req.params.id,
      role: req.body.role,
      pais: req.body.pais,
      adminId: req.user.id,
    });
    const esAdmin = user.role !== 'USER';
    return ok(
      res,
      { user },
      {
        message: !cambiado
          ? 'La cuenta ya tenía ese acceso.'
          : esAdmin
            ? 'Listo: ya es administrador. Tiene que volver a iniciar sesión para ver el panel.'
            : 'Acceso de administrador quitado. Vuelve a ser una cuenta de usuario.',
      },
    );
  }),

  paises: asyncHandler(async (_req, res) => {
    return ok(res, { paises: await userService.paisesConAdministrador() });
  }),

  list: asyncHandler(async (req, res) => {
    // El administrador de país solo ve las cuentas de su país: sus clientes.
    const { items, meta, conteo } = await userService.list(req.query, dondePais(req.alcance));
    return ok(res, { users: items, meta, conteo });
  }),
};

module.exports = userController;
