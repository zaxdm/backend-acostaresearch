'use strict';

const { Router } = require('express');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const env = require('../../config/env');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { z } = require('zod');
const validate = require('../../middlewares/validate');
const { scieloLimiter } = require('../../middlewares/rateLimit');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const openalex = require('./openalex.client');
const { busquedaDeConceptos } = require('../scopus/scopus.cuentas');
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

/**
 * Buscar en las revistas de SciELO. Ver `openalex.buscarEnScielo`.
 *
 * Aquí y no en `/mi-scopus`: no hay nada que conectar ni cuota de Elsevier que
 * gastar, y lo que se guarda va a esta misma biblioteca.
 */
const anio = z.coerce.number().int().min(1900).max(2100).optional();
const conceptoSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  sinonimos: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
});
const buscarEnScieloSchema = z
  .object({
    tema: z
      .string()
      .trim()
      .min(3, 'Escribe al menos tres caracteres.')
      .max(300, 'Esa búsqueda es demasiado larga.')
      .optional(),
    /** Los del buscador de Scopus, para la lista mezclada. */
    conceptos: z.array(conceptoSchema).min(1).max(8).optional(),
    pagina: z.coerce.number().int().min(1).max(200).optional(),
    porPagina: z.coerce.number().int().min(5).max(25).optional(),
    orden: z.enum(['relevancia', 'citas', 'recientes', 'antiguos']).optional(),
    idioma: z.enum(['es', 'pt', 'en']).optional(),
    desdeAnio: anio,
    hastaAnio: anio,
  })
  .refine((cuerpo) => cuerpo.tema || cuerpo.conceptos, { message: 'Escribe qué quieres buscar.' });

router.post(
  '/scielo/buscar',
  scieloLimiter,
  validate({ body: buscarEnScieloSchema }),
  asyncHandler(async (req, res) => {
    const { conceptos, ...resto } = req.body;
    const consulta = conceptos ? busquedaDeConceptos(conceptos) : null;
    if (conceptos && !consulta) return ok(res, { resultados: [], total: 0, porPagina: 0 });

    const resultado = await openalex.buscarEnScielo({ ...resto, consulta });
    if (resultado.caida) {
      throw new AppError('El catálogo de SciELO no responde ahora. Prueba en unos minutos.', {
        statusCode: 502,
        code: ERROR_CODES.CATALOG_UNAVAILABLE,
      });
    }

    const resultados = await propiasService.marcarLasQueTiene(req.user.id, resultado.resultados);
    return ok(
      res,
      { resultados, total: resultado.total, porPagina: req.body.porPagina ?? openalex.POR_PAGINA_SCIELO },
      {
        message:
          resultado.total === 0
            ? 'SciELO no tiene nada con esas palabras. Prueba con menos, o en otro idioma.'
            : undefined,
      },
    );
  }),
);

router.post(
  '/scielo',
  scieloLimiter,
  validate({
    body: z.object({
      ids: z
        .array(z.string().trim().max(64))
        .min(1, 'No marcaste ningún artículo.')
        .max(25, 'Puedes guardar hasta 25 de una vez.'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.importarDeScielo({ userId: req.user.id, ids: req.body.ids });

    const partes = [`Guardamos ${resultado.guardadas} fuentes nuevas`];
    if (resultado.repetidas > 0) partes.push(`${resultado.repetidas} ya las tenías`);
    if (resultado.noEncontradas > 0) {
      partes.push(`${resultado.noEncontradas} ya no aparecen en el catálogo`);
    }

    return ok(res, resultado, { message: `${partes.join(', ')}.` });
  }),
);

router.delete(
  '/',
  asyncHandler(async (req, res) => {
    const { borradas, conservadas } = await propiasService.vaciar(req.user.id);
    const mensaje =
      conservadas > 0
        ? `Se borraron ${borradas} fuentes tuyas. Se conservaron ${conservadas} porque las citas ` +
          'en tus capítulos: borrarlas dejaría esas citas rotas en tu Word.'
        : `Se borraron ${borradas} fuentes tuyas.`;
    return ok(res, { borradas, conservadas }, { message: mensaje });
  }),
);

module.exports = router;
