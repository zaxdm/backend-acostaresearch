'use strict';

const { Router } = require('express');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const env = require('../../config/env');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const propiasService = require('./propias.service');

const router = Router();

/**
 * La biblioteca propia del comprador.
 *
 * A diferencia del resto del módulo —que es del administrador y sirve el corpus
 * de la casa—, esto es de cada uno: solo hace falta sesión, y todas las rutas
 * trabajan sobre `req.user.id` sin aceptar de quién por parámetro. Un
 * identificador de usuario que viaje en la petición es la forma más rápida de
 * acabar leyendo la biblioteca de otro.
 */
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await propiasService.resumen(req.user.id))),
);

/**
 * La subida va con el cuerpo crudo y su propio techo.
 *
 * El resto de la API está capada a 100 KB en `app.js`, que es lo correcto para
 * JSON y ridículo para un export de Scopus: quinientas fuentes con resumen son
 * un par de megas. Se abre aquí y solo aquí, igual que se abrió para el
 * comprobante de Yape, y `type` acota qué se acepta parsear —aunque el formato
 * real lo decide el lector mirando el contenido, no esta lista—.
 */
router.post(
  '/',
  express.raw({ type: propiasService.TIPOS, limit: env.IMPORT_MAX_BYTES }),
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.importar({ userId: req.user.id, buffer: req.body });

    const mensaje =
      `Guardamos ${resultado.guardadas} fuentes nuevas` +
      (resultado.repetidas > 0 ? `, y ${resultado.repetidas} que ya tenías` : '') +
      `. Ya puedes pedírselas a Claude.`;

    return ok(res, resultado, { message: mensaje });
  }),
);

/**
 * Fuentes a partir de los DOIs que el navegador sacó de unos PDFs.
 *
 * Llega JSON y no un archivo, así que va por el parser normal y su límite de
 * 100 KB sobra: sesenta DOIs son dos kilobytes. El PDF se queda en el equipo
 * del tesista, que es la mitad del valor de hacerlo así.
 */
router.post(
  '/doi',
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.importarPorDoi({
      userId: req.user.id,
      dois: req.body?.dois,
    });

    const partes = [`Guardamos ${resultado.guardadas} fuentes nuevas`];
    if (resultado.repetidas > 0) partes.push(`${resultado.repetidas} ya las tenías`);
    if (resultado.noEncontrados.length > 0) {
      partes.push(`${resultado.noEncontrados.length} no aparecen en el catálogo abierto`);
    }

    return ok(res, resultado, { message: `${partes.join(', ')}.` });
  }),
);

router.delete(
  '/',
  asyncHandler(async (req, res) => {
    const borradas = await propiasService.vaciar(req.user.id);
    return ok(res, { borradas }, { message: `Se borraron ${borradas} fuentes tuyas.` });
  }),
);

module.exports = router;
