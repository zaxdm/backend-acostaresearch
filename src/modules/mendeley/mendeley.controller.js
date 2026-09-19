'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const env = require('../../config/env');
const logger = require('../../config/logger');
const servicio = require('./mendeley.service');

/**
 * La cookie que ata el intercambio con Mendeley al navegador que lo empezó.
 * `lax` porque la vuelta es una navegación de primer nivel; media hora; y solo
 * viaja a las rutas de Mendeley. Ver el controlador de Zotero, que es igual.
 */
const COOKIE_MENDELEY = 'mendeley_oauth';

const opcionesDeCookie = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',
  domain: env.COOKIE_DOMAIN || undefined,
  path: `${env.API_PREFIX}/mi-mendeley`,
  maxAge: 30 * 60 * 1000,
});

const mendeleyController = {
  estado: asyncHandler(async (req, res) => {
    return ok(res, { mendeley: await servicio.estado(req.user.id) });
  }),

  conectar: asyncHandler(async (req, res) => {
    const empezado = await servicio.empezar(req.user.id);
    res.cookie(COOKIE_MENDELEY, empezado.state, opcionesDeCookie());
    return ok(res, { url: empezado.url });
  }),

  /**
   * La vuelta desde mendeley.com. La abre el NAVEGADOR: responde siempre con
   * una redirección al panel, nunca con JSON, y un fallo se lleva en la
   * dirección en vez de dejarle un `{"success":false}` en pantalla.
   */
  vuelta: asyncHandler(async (req, res) => {
    const { code: codigo, state, error } = req.query;

    const stateDelNavegador = req.cookies?.[COOKIE_MENDELEY];
    res.clearCookie(COOKIE_MENDELEY, opcionesDeCookie());

    if (error || !codigo || !state) {
      return res.redirect(servicio.urlDelPanel('cancelado'));
    }

    try {
      await servicio.terminar({ codigo, state, stateDelNavegador });
      return res.redirect(servicio.urlDelPanel('ok'));
    } catch (fallo) {
      logger.error({ err: fallo }, 'Falló la vuelta del OAuth de Mendeley');
      return res.redirect(servicio.urlDelPanel('error'));
    }
  }),

  carpetas: asyncHandler(async (req, res) => {
    return ok(res, await servicio.carpetas(req.user.id));
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
          ? `${resultado.guardadas} fuentes nuevas de tu Mendeley.`
          : 'Tu biblioteca ya estaba al día.',
    });
  }),

  desconectar: asyncHandler(async (req, res) => {
    await servicio.desconectar(req.user.id);
    return ok(
      res,
      { ok: true },
      { message: 'Mendeley desconectado. Las fuentes que ya trajiste siguen en tu biblioteca.' },
    );
  }),
};

module.exports = mendeleyController;
