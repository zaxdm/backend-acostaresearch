'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const servicio = require('./mapas.service');

const mapasController = {
  umbral: asyncHandler(async (req, res) => {
    return ok(res, await servicio.umbral(req.user.id, req.body));
  }),

  mapa: asyncHandler(async (req, res) => {
    return ok(res, await servicio.crearMapa(req.user.id, req.body));
  }),

  /**
   * La forma de la primera versión, que solo hacía coocurrencia: la usa la web
   * que alguien tenga abierta desde antes del despliegue, hasta que recargue.
   * Se puede borrar pasados unos días.
   */
  coocurrencia: asyncHandler(async (req, res) => {
    const mapa = await servicio.crearMapa(req.user.id, { ...req.body, analisis: 'coocurrencia' });
    const r = mapa.resumen;
    return ok(res, {
      ...mapa,
      resumen: {
        ...r,
        documentosConTerminos: r.documentosConUnidades,
        terminosDistintos: r.unidadesDistintas,
        terminos: r.filas.map((f) => ({
          termino: f.etiqueta,
          ocurrencias: f.ocurrencias,
          enlaces: f.enlaces,
          fuerza: f.fuerza,
          anioPromedio: f.anio,
          citasPromedio: f.citasProm,
        })),
      },
    });
  }),
};

module.exports = mapasController;
