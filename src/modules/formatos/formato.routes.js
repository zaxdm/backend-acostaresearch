'use strict';

const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const { ValidationError } = require('../../shared/errors/AppError');
const { MAXIMO_BYTES } = require('../projects/project.plantilla');
const { formatoBodySchema, formatoPatchSchema, idParamSchema } = require('./formato.schema');
const formatoService = require('./formato.service');

/**
 * La biblioteca de formatos de universidad, desde /admin. Todo es del
 * administrador: lo que ve el tesista sale por el conector
 * (`formato_de_la_universidad`), no por aquí.
 *
 * El .docx va en crudo con su ficha en la query, como las guías en PDF.
 */
const router = express.Router();

const docx = express.raw({ type: () => true, limit: MAXIMO_BYTES });

function nombreSubido(req) {
  try {
    return decodeURIComponent(req.get('X-Nombre-Archivo') ?? '');
  } catch {
    return '';
  }
}

router.use(authenticate, authorize(ROLES.ADMIN));

router.get(
  '/',
  asyncHandler(async (_req, res) => ok(res, { formatos: await formatoService.listar() })),
);

// Los métodos de tesis y sus fases: con qué se arma el esquema de capítulos.
router.get(
  '/metodos',
  asyncHandler(async (_req, res) => ok(res, { metodos: await formatoService.metodos() })),
);

router.post(
  '/',
  docx,
  asyncHandler(async (req, res) => {
    const datos = formatoBodySchema.safeParse(req.query);
    if (!datos.success) throw new ValidationError(datos.error.issues[0]?.message ?? 'Revisa la ficha.');
    const formato = await formatoService.crear(datos.data, req.body, nombreSubido(req));
    return created(res, { formato }, `Formato de «${formato.universidad}» subido.`);
  }),
);

router.patch(
  '/:id',
  validate({ params: idParamSchema, body: formatoPatchSchema }),
  asyncHandler(async (req, res) => {
    const formato = await formatoService.actualizar(req.params.id, req.body);
    return ok(res, { formato }, { message: `Formato de «${formato.universidad}» guardado.` });
  }),
);

router.get(
  '/:id/docx',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res, next) => {
    const { ruta, nombre } = await formatoService.paraDescargar(req.params.id);
    res.attachment(nombre);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(ruta, (error) => {
      if (error) next(error.status === 404 ? undefined : error);
    });
  }),
);

router.put(
  '/:id/docx',
  validate({ params: idParamSchema }),
  docx,
  asyncHandler(async (req, res) => {
    const formato = await formatoService.reemplazarArchivo(req.params.id, req.body, nombreSubido(req));
    return ok(res, { formato }, { message: 'Archivo cambiado. Los tesistas que ya lo tenían siguen con el anterior.' });
  }),
);

router.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    await formatoService.borrar(req.params.id);
    return noContent(res);
  }),
);

module.exports = router;
