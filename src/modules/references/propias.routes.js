'use strict';

const { Router } = require('express');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const env = require('../../config/env');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { z } = require('zod');
const validate = require('../../middlewares/validate');
const { scieloLimiter, openalexLimiter, externasLimiter } = require('../../middlewares/rateLimit');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');
const openalex = require('./openalex.client');
const { busquedaDeConceptos } = require('../scopus/scopus.cuentas');
const propiasService = require('./propias.service');
const externas = require('../externas');

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
 * Sus fuentes enteras, para «Descargar» del panel. El archivo (CSV, RIS o
 * BibTeX) lo arma el navegador: aquí solo viajan los datos, y solo los suyos.
 */
router.get(
  '/descargar',
  asyncHandler(async (req, res) => ok(res, { fuentes: await propiasService.paraDescargar(req.user.id) })),
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
 * Fuentes sin DOI, con la ficha escrita a mano. Ver `propiasService.importarAMano`.
 *
 * Llega JSON: el PDF tampoco viaja por aquí. El resumen es lo único largo y
 * con su tope cabe en el parser normal aunque vengan varias.
 */
const texto = (largo) => z.string().trim().max(largo).optional().default('');
const aManoSchema = z.object({
  fuentes: z
    .array(
      z.object({
        titulo: z
          .string()
          .trim()
          .min(5, 'Escribe el título completo de la fuente.')
          .max(500, 'Ese título es demasiado largo.'),
        autores: texto(500),
        anio: z.coerce.number().int().min(1500).max(2100).nullish(),
        fuente: texto(300),
        tipo: z.enum(Object.keys(propiasService.TIPOS_A_MANO)).default('otro'),
        url: texto(500),
        resumen: texto(4000),
      }),
    )
    .min(1, 'No llegó ninguna ficha que guardar.')
    .max(
      propiasService.MAXIMO_A_MANO,
      `Puedes guardar hasta ${propiasService.MAXIMO_A_MANO} fichas de una vez.`,
    ),
});

router.post(
  '/a-mano',
  validate({ body: aManoSchema }),
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.importarAMano({
      userId: req.user.id,
      fuentes: req.body.fuentes,
    });

    const partes = [`Guardamos ${resultado.guardadas} fuentes nuevas`];
    if (resultado.repetidas > 0) partes.push(`${resultado.repetidas} ya las tenías`);

    return ok(res, resultado, { message: `${partes.join(', ')}. Ya puedes pedírselas a Claude.` });
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

/**
 * Buscar en un catálogo de OpenAlex: SciELO o el resto (ver
 * `openalex.buscarEnElResto`). Las dos partes abiertas de la lista mezclada.
 */
function buscarEnCatalogo(buscar, nombre) {
  return asyncHandler(async (req, res) => {
    const { conceptos, ...resto } = req.body;
    const consulta = conceptos ? busquedaDeConceptos(conceptos) : null;
    if (conceptos && !consulta) return ok(res, { resultados: [], total: 0, porPagina: 0 });

    const resultado = await buscar({ ...resto, consulta });
    if (resultado.caida) {
      throw new AppError(`El catálogo de ${nombre} no responde ahora. Prueba en unos minutos.`, {
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
            ? `${nombre} no tiene nada con esas palabras. Prueba con menos, o en otro idioma.`
            : undefined,
      },
    );
  });
}

router.post(
  '/scielo/buscar',
  scieloLimiter,
  validate({ body: buscarEnScieloSchema }),
  buscarEnCatalogo((opciones) => openalex.buscarEnScielo(opciones), 'SciELO'),
);

/** El resto de OpenAlex, sin SciELO y con tesis. Lo que se guarda va por `/scielo`. */
router.post(
  '/openalex/buscar',
  openalexLimiter,
  validate({ body: buscarEnScieloSchema }),
  buscarEnCatalogo((opciones) => openalex.buscarEnElResto(opciones), 'OpenAlex'),
);

/**
 * Las bases externas del menú «Ver»: Semantic Scholar, PubMed, ERIC, CORE…
 * Ver `modules/externas/index.js`. Una sola base por búsqueda.
 */
router.get(
  '/externas',
  asyncHandler(async (_req, res) => ok(res, { bases: externas.lista() })),
);

router.post(
  '/externas/:base/buscar',
  externasLimiter,
  validate({ body: buscarEnScieloSchema }),
  asyncHandler(async (req, res) => {
    const base = externas.base(req.params.base);
    if (!base || !base.activa()) {
      throw new AppError('Esa base no está disponible ahora.', {
        statusCode: 404,
        code: ERROR_CODES.CATALOG_UNAVAILABLE,
      });
    }
    const { conceptos, tema, pagina = 1, porPagina = 25, desdeAnio = null, hastaAnio = null } = req.body;
    const consulta = conceptos ? busquedaDeConceptos(conceptos) : String(tema ?? '').replace(/,/g, ' ');
    if (!consulta) return ok(res, { resultados: [], total: 0, porPagina: 0 });
    // Las mismas ideas en palabras sueltas, para las bases que no entienden AND/OR.
    const palabras = conceptos
      ? conceptos.map((c) => c.nombre).join(' ')
      : String(tema ?? '').replace(/,/g, ' ');

    const resultado = await base.buscar({
      consulta,
      palabras,
      pagina,
      porPagina,
      desde: desdeAnio,
      hasta: hastaAnio,
    });
    if (resultado.caida) {
      throw new AppError(`${base.nombre} no responde ahora. Prueba en unos minutos.`, {
        statusCode: 502,
        code: ERROR_CODES.CATALOG_UNAVAILABLE,
      });
    }

    const resultados = await propiasService.marcarLasQueTieneDe(req.user.id, base.clave, resultado.resultados);
    return ok(
      res,
      { resultados, total: resultado.total, porPagina },
      {
        message:
          resultado.total === 0
            ? `${base.nombre} no tiene nada con esas palabras. Prueba con menos, o en inglés.`
            : undefined,
      },
    );
  }),
);

router.post(
  '/externas',
  externasLimiter,
  validate({
    body: z.object({
      ids: z
        .array(z.string().trim().max(240))
        .min(1, 'No marcaste ningún artículo.')
        .max(25, 'Puedes guardar hasta 25 de una vez.'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.importarDeExternas({ userId: req.user.id, ids: req.body.ids });
    const partes = [`Guardamos ${resultado.guardadas} fuentes nuevas`];
    if (resultado.repetidas > 0) partes.push(`${resultado.repetidas} ya las tenías`);
    if (resultado.noEncontradas > 0) partes.push(`${resultado.noEncontradas} ya no aparecen en su base`);
    return ok(res, resultado, { message: `${partes.join(', ')}.` });
  }),
);

/**
 * Las palabras de una búsqueda vacía que no existen en ningún artículo. Ver
 * `openalex.palabrasSinUso`. Se quitan las vacías («la», «the»…) y las cortas:
 * esas existen siempre y solo gastarían consultas.
 */
const VACIAS = new Set(
  ('a al con de del el en la las los para por que un una y the of in on and for to with from ' +
    'among between its their into at by o e da do das dos em na no nas nos um uma')
    .split(' '),
);
router.post(
  '/palabras-sin-uso',
  scieloLimiter,
  validate({ body: z.object({ texto: z.string().trim().min(1).max(300) }) }),
  asyncHandler(async (req, res) => {
    const palabras = [
      ...new Set(
        req.body.texto
          .toLowerCase()
          .split(/[^\p{L}\p{N}-]+/u)
          .filter((p) => p.length >= 4 && !VACIAS.has(p)),
      ),
    ].slice(0, 10);
    return ok(res, { palabras: palabras.length ? await openalex.palabrasSinUso(palabras) : [] });
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

/**
 * Una sola fuente, por su clave de cita («AR…»). Corregir la ficha o borrarla.
 * La clave nunca basta para tocar la de otro: el servicio busca con el dueño.
 */
const claveSchema = z.object({
  clave: z
    .string()
    .trim()
    .regex(/^AR[0-9A-F]{8}$/i, 'Esa clave no es válida.')
    .transform((clave) => clave.toUpperCase()),
});

router.patch(
  '/:clave',
  validate({
    params: claveSchema,
    body: z.object({
      titulo: z
        .string()
        .trim()
        .min(5, 'Escribe el título completo de la fuente.')
        .max(500, 'Ese título es demasiado largo.'),
      autores: texto(500),
      anio: z.coerce.number().int().min(1500).max(2100).nullish(),
      fuente: texto(300),
      tipo: z.enum(Object.keys(propiasService.TIPOS_A_MANO)).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.corregir({
      userId: req.user.id,
      clave: req.params.clave,
      ficha: req.body,
    });
    return ok(res, resultado, { message: 'Fuente corregida. Su clave de cita no cambia.' });
  }),
);

router.delete(
  '/:clave',
  validate({ params: claveSchema }),
  asyncHandler(async (req, res) => {
    const resultado = await propiasService.borrarUna({ userId: req.user.id, clave: req.params.clave });
    return ok(res, resultado, { message: 'Fuente borrada.' });
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
