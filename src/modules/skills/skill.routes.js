'use strict';

const { Router } = require('express');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const env = require('../../config/env');
const {
  uploadQuerySchema,
  catalogQuerySchema,
  updateSchema,
  idParamSchema,
  capitulosDelGrupoSchema,
  grupoParamSchema,
} = require('./skill.schema');
const skillController = require('./skill.controller');

const router = Router();

/**
 * El bundle llega como cuerpo binario, no como formulario multiparte.
 *
 * Es un único archivo y sus metadatos caben en la query, así que `multipart`
 * solo añadiría una dependencia y una capa de análisis para obtener lo mismo.
 * `express.raw` deja el .skill en `req.body` como Buffer y ya.
 *
 * Se aceptan los tres tipos con los que los navegadores etiquetan un .skill:
 * como el navegador no conoce la extensión, lo manda casi siempre como
 * `application/octet-stream`.
 */
const bundle = express.raw({
  type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  limit: env.SKILLS_MAX_BYTES,
});

// ── Público ────────────────────────────────────────────────────────────────
// La portada lista los capítulos sin pedir sesión: quien llega desde TikTok
// tiene que poder ver qué se vende antes de registrarse.
router.get('/catalogo', validate({ query: catalogQuerySchema }), skillController.catalog);

// ── Administración ─────────────────────────────────────────────────────────
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/', skillController.list);
router.post('/inspeccionar', bundle, skillController.inspect);
router.post('/', bundle, validate({ query: uploadQuerySchema }), skillController.upload);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateSchema }),
  skillController.update,
);
// Los capítulos de un grupo, de una vez. Va antes que `/:id` para que
// «grupos» no se lea como un identificador.
router.put(
  '/grupos/:productCode',
  validate({ params: grupoParamSchema, body: capitulosDelGrupoSchema }),
  skillController.setGroupSkills,
);

router.delete('/:id', validate({ params: idParamSchema }), skillController.remove);

module.exports = router;
