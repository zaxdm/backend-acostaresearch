'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { normalizar } = require('./zotero.mapper');
const referenceService = require('./reference.service');

const referenceController = {
  /** Lo que ve el panel al abrir, y lo que consulta mientras sincroniza. */
  status: asyncHandler(async (_req, res) => {
    return ok(res, await referenceService.estado());
  }),

  list: asyncHandler(async (req, res) => {
    const { texto, ...resto } = req.query;
    // El buscador del panel escribe con tildes; la columna las guarda sin.
    const datos = await referenceService.listarParaPanel({ ...resto, texto: normalizar(texto) });
    return ok(res, datos);
  }),

  /**
   * Arranca la sincronización y contesta enseguida.
   *
   * No devuelve el resultado porque no lo tiene: la primera pasada son unas
   * cuatrocientas peticiones a Zotero y varios minutos, y ninguna petición HTTP
   * aguanta eso. El panel pregunta por `/estado` cada pocos segundos.
   */
  sync: asyncHandler(async (req, res) => {
    const trabajo = await referenceService.sincronizar(req.body);

    const mensaje = trabajo.completa
      ? 'Leyendo la biblioteca entera. Con 24.000 fuentes esto tarda varios minutos; ' +
        'puedes cerrar esta página y volver luego.'
      : 'Sincronizando con Zotero. Aquí abajo verás cómo va.';

    // 202: aceptado y en marcha, no terminado. El estado va por otra ruta.
    return ok(res, trabajo, { status: 202, message: mensaje });
  }),
};

module.exports = referenceController;
