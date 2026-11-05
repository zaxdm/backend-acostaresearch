'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const env = require('../../config/env');
const logger = require('../../config/logger');
const servicio = require('./mendeley.service');
const acostaiaConectores = require('../acostaia/acostaia.conectores');

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
    // Si el intercambio salió de AcostaIA, se vuelve allí y no al perfil.
    const deAcostaIA = acostaiaConectores.esDeAcostaIA('mendeley', state);
    const destino = (resultado) =>
      deAcostaIA ? acostaiaConectores.urlDeVuelta('mendeley', resultado) : servicio.urlDelPanel(resultado);

    const stateDelNavegador = req.cookies?.[COOKIE_MENDELEY];
    res.clearCookie(COOKIE_MENDELEY, opcionesDeCookie());

    if (error || !codigo || !state) {
      return res.redirect(destino('cancelado'));
    }

    try {
      await servicio.terminar({ codigo, state, stateDelNavegador });
      return res.redirect(destino('ok'));
    } catch (fallo) {
      logger.error({ err: fallo }, 'Falló la vuelta del OAuth de Mendeley');
      return res.redirect(destino('error'));
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
/** La cookie del intercambio, para que AcostaIA la deje igual (ver acostaia.routes). */
module.exports.cookieDelIntercambio = () => ({ nombre: COOKIE_MENDELEY, opciones: opcionesDeCookie() });
