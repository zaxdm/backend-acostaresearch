'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const logger = require('../../config/logger');
const servicio = require('./biblioteca.service');

const bibliotecaController = {
  estado: asyncHandler(async (req, res) => {
    return ok(res, { zotero: await servicio.estado(req.user.id) });
  }),

  conectar: asyncHandler(async (req, res) => {
    return ok(res, await servicio.empezar(req.user.id));
  }),

  /**
   * La vuelta desde zotero.org.
   *
   * Esto lo abre el NAVEGADOR, no el panel: responde con una redirección y
   * nunca con JSON. Un error aquí tampoco puede salir por el manejador de
   * errores de la API —le dejaría al tesista un `{"success":false}` en pantalla
   * como toda explicación— así que se atrapa y se le lleva de vuelta al panel
   * con el motivo en la dirección.
   */
  vuelta: asyncHandler(async (req, res) => {
    const token = req.query.oauth_token;
    const verificador = req.query.oauth_verifier;

    if (!token || !verificador) {
      return res.redirect(servicio.urlDelPanel('cancelado'));
    }

    try {
      await servicio.terminar({ token, verificador });
      return res.redirect(servicio.urlDelPanel('ok'));
    } catch (fallo) {
      logger.error({ err: fallo }, 'Falló la vuelta del OAuth de Zotero');
      return res.redirect(servicio.urlDelPanel('error'));
    }
  }),

  colecciones: asyncHandler(async (req, res) => {
    // Va la lista Y el tamaño de la biblioteca entera, que es una opción más.
    return ok(res, await servicio.colecciones(req.user.id));
  }),

  elegir: asyncHandler(async (req, res) => {
    const { coleccion } = await servicio.elegir(req.user.id, req.body.clave);
    return ok(
      res,
      { coleccion },
      { message: `Trayendo «${coleccion.nombre}». Tarda unos segundos.` },
    );
  }),

  sincronizar: asyncHandler(async (req, res) => {
    const resultado = await servicio.sincronizar(req.user.id);
    return ok(res, resultado, {
      message:
        resultado.guardadas > 0
          ? `${resultado.guardadas} fuentes nuevas de tu Zotero.`
          : 'Tu biblioteca ya estaba al día.',
    });
  }),

  desconectar: asyncHandler(async (req, res) => {
    await servicio.desconectar(req.user.id);
    return ok(
      res,
      { ok: true },
      { message: 'Zotero desconectado. Las fuentes que ya trajiste siguen en tu biblioteca.' },
    );
  }),
};

module.exports = bibliotecaController;
