'use strict';

const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const { ROLES } = require('../../config/constants');
const { ValidationError } = require('../../shared/errors/AppError');
const { guiaBodySchema, guiaPatchSchema, idParamSchema } = require('./guia.schema');
const guiaService = require('./guia.service');

const router = express.Router();

/**
 * El PDF va en crudo, con su ficha en la query, como el .skill del panel: es un
 * solo archivo y `multipart` añadiría una dependencia para obtener lo mismo.
 */
const MAXIMO_BYTES = 25 * 1024 * 1024;
const pdf = express.raw({ type: () => true, limit: MAXIMO_BYTES });

/** El nombre con el que se subió va en una cabecera: la query ya lleva la ficha. */
function nombreSubido(req) {
  try {
    return decodeURIComponent(req.get('X-Nombre-Archivo') ?? '');
  } catch {
    return '';
  }
}

// ── Público ────────────────────────────────────────────────────────────────
// Como los tutoriales: una guía para conectar algo que todavía no tienes no le
// regala nada a nadie, y la alcanza quien compró sin volver a entrar a la web.

router.get(
  '/',
  asyncHandler(async (_req, res) => ok(res, { guias: await guiaService.listPublic() })),
);

router.get(
  '/:id/pdf',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res, next) => {
    const { ruta, nombre } = await guiaService.paraDescargar(req.params.id);
    res.attachment(nombre);
    res.sendFile(ruta, (error) => {
      // Ficha sin archivo en disco: que caiga en el 404 normal y quede en el log.
      if (error) next(error.status === 404 ? undefined : error);
    });
  }),
);

// ── Administración ─────────────────────────────────────────────────────────
router.use(authenticate, authorize(ROLES.ADMIN));

router.get(
  '/todas',
  asyncHandler(async (_req, res) => ok(res, { guias: await guiaService.listAll() })),
);

router.post(
  '/',
  pdf,
  asyncHandler(async (req, res) => {
    const datos = guiaBodySchema.safeParse(req.query);
    if (!datos.success) throw new ValidationError(datos.error.issues[0]?.message ?? 'Revisa la ficha.');

    const guia = await guiaService.create(datos.data, req.body, nombreSubido(req));
    return created(res, { guia }, `«${guia.titulo}» subida. Ya se ve en la web.`);
  }),
);

router.patch(
  '/:id',
  validate({ params: idParamSchema, body: guiaPatchSchema }),
  asyncHandler(async (req, res) => {
    const guia = await guiaService.update(req.params.id, req.body);
    return ok(res, { guia }, { message: `«${guia.titulo}» actualizada.` });
  }),
);

router.put(
  '/:id/pdf',
  validate({ params: idParamSchema }),
  pdf,
  asyncHandler(async (req, res) => {
    const guia = await guiaService.reemplazarArchivo(req.params.id, req.body, nombreSubido(req));
    return ok(res, { guia }, { message: `PDF de «${guia.titulo}» cambiado.` });
  }),
);

router.delete(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    await guiaService.remove(req.params.id);
    return noContent(res);
  }),
);

module.exports = router;
