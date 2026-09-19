'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const env = require('../../config/env');
const logger = require('../../config/logger');
const servicio = require('./scopus.service');
const { generarConsulta } = require('./scopus.consulta');
const { resumir, resumenesDeLaPagina } = require('./scopus.resumen');
const { aproximadas } = require('./scopus.cuentas');
const guardadas = require('./scopus.guardadas');

/**
 * La cookie que ata el intercambio con Elsevier al navegador que lo empezó.
 *
 * Misma forma que la de Zotero y por lo mismo. `lax` y no `none`: la vuelta
 * desde Elsevier es una navegación normal del navegador —un GET de primer
 * nivel—, que es justo lo que `lax` deja pasar. Vive media hora, de sobra para
 * autorizar, y solo viaja a las rutas de Scopus.
 */
const COOKIE_SCOPUS = 'scopus_oauth';

const opcionesDeCookie = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',
  domain: env.COOKIE_DOMAIN || undefined,
  path: `${env.API_PREFIX}/mi-scopus`,
  maxAge: 30 * 60 * 1000,
});

const scopusController = {
  estado: asyncHandler(async (req, res) => {
    return ok(res, { scopus: await servicio.estado(req.user.id) });
  }),

  conectar: asyncHandler(async (req, res) => {
    const empezado = await servicio.empezar(req.user.id);

    // Sin OAuth no hay viaje ni intercambio que atar: la conexión queda hecha.
    if (empezado.conectado) {
      return ok(
        res,
        { conectado: true, url: null },
        { message: 'Scopus conectado. Ya puedes buscar.' },
      );
    }

    // La marca de que fue ESTE navegador el que empezó. Vuelve sola desde
    // Elsevier y allí se exige que coincida: ver `terminar` en el servicio.
    res.cookie(COOKIE_SCOPUS, empezado.state, opcionesDeCookie());
    return ok(res, { conectado: false, url: empezado.url });
  }),

  /**
   * La vuelta desde Elsevier.
   *
   * Esto lo abre el NAVEGADOR, no el panel: responde con una redirección y
   * nunca con JSON. Un error aquí tampoco puede salir por el manejador de
   * errores de la API —le dejaría al tesista un `{"success":false}` en pantalla
   * como toda explicación— así que se atrapa y se le lleva de vuelta al panel
   * con el motivo en la dirección.
   */
  vuelta: asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;

    const stateDelNavegador = req.cookies?.[COOKIE_SCOPUS];
    res.clearCookie(COOKIE_SCOPUS, opcionesDeCookie());

    // `access_denied` es la respuesta de quien pulsa «no autorizo». No es un
    // fallo y no se le enseña como tal.
    if (error || !code || !state) {
      return res.redirect(servicio.urlDelPanel(error === 'access_denied' || !error ? 'cancelado' : 'rechazado'));
    }

    try {
      await servicio.terminar({ state, codigo: code, stateDelNavegador });
      return res.redirect(servicio.urlDelPanel('ok'));
    } catch (fallo) {
      logger.error({ err: fallo }, 'Falló la vuelta del OAuth de Scopus');
      return res.redirect(servicio.urlDelPanel('error'));
    }
  }),

  buscar: asyncHandler(async (req, res) => {
    const resultado = await servicio.buscar(req.user.id, {
      ecuacion: req.body.ecuacion,
      pagina: req.body.pagina,
      orden: req.body.orden,
    });

    return ok(res, resultado, {
      message:
        resultado.total === 0
          ? 'Scopus no encontró nada con esa ecuación. Prueba con menos términos o quita comillas.'
          : undefined,
    });
  }),

  generarConsulta: asyncHandler(async (req, res) => {
    return ok(res, await generarConsulta(req.body.tema));
  }),

  resumir: asyncHandler(async (req, res) => {
    return ok(
      res,
      await resumir({
        pregunta: req.body.pregunta,
        fuentes: req.body.fuentes,
        anteriores: req.body.anteriores ?? [],
      }),
    );
  }),

  resumenes: asyncHandler(async (req, res) => {
    return ok(res, { resumenes: await resumenesDeLaPagina(req.body.dois) });
  }),

  cuentas: asyncHandler(async (req, res) => {
    return ok(res, await servicio.cuentas(req.user.id, req.body));
  }),

  cuentasAproximadas: asyncHandler(async (req, res) => {
    return ok(res, await aproximadas(req.body));
  }),

  semantica: asyncHandler(async (req, res) => {
    return ok(res, await servicio.buscarSemantica(req.user.id, req.body));
  }),

  guardadas: asyncHandler(async (req, res) => {
    return ok(res, { guardadas: await guardadas.listar(req.user.id) });
  }),

  guardada: asyncHandler(async (req, res) => {
    return ok(res, { guardada: await guardadas.una(req.user.id, req.params.id) });
  }),

  guardar: asyncHandler(async (req, res) => {
    return ok(res, { guardada: await guardadas.crear(req.user.id, req.body) });
  }),

  actualizarGuardada: asyncHandler(async (req, res) => {
    return ok(res, { guardada: await guardadas.actualizar(req.user.id, req.params.id, req.body) });
  }),

  borrarGuardada: asyncHandler(async (req, res) => {
    await guardadas.borrar(req.user.id, req.params.id);
    return ok(res, { ok: true });
  }),

  importar: asyncHandler(async (req, res) => {
    const resultado = await servicio.importar(req.user.id, { eids: req.body.eids });

    const partes = [
      resultado.guardadas === 1
        ? '1 fuente importada correctamente'
        : `${resultado.guardadas} fuentes importadas correctamente`,
    ];
    if (resultado.repetidas > 0) partes.push(`${resultado.repetidas} ya las tenías`);
    if (resultado.noEncontradas > 0) {
      partes.push(`${resultado.noEncontradas} ya no las devuelve Scopus`);
    }

    return ok(res, resultado, { message: `${partes.join(', ')}.` });
  }),

  desconectar: asyncHandler(async (req, res) => {
    await servicio.desconectar(req.user.id);
    return ok(
      res,
      { ok: true },
      { message: 'Scopus desconectado. Las fuentes que ya importaste siguen en tu biblioteca.' },
    );
  }),
};

module.exports = scopusController;
