'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const {
  tutorialBodySchema,
  tutorialPatchSchema,
  idParamSchema,
} = require('./tutorial.schema');
const tutorialController = require('./tutorial.controller');

const router = Router();

// Pública: la página de tutoriales no pide sesión. Un video que enseña a
// conectar algo que todavía no tienes no le regala nada a nadie, y así la
// alcanza quien compró y no ha vuelto a entrar a la web.
router.get('/', tutorialController.list);

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/todos', tutorialController.listAll);
router.post('/', validate({ body: tutorialBodySchema }), tutorialController.create);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: tutorialPatchSchema }),
  tutorialController.update,
);
router.delete('/:id', validate({ params: idParamSchema }), tutorialController.remove);

module.exports = router;
