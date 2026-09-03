'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const { rewriteLimiter } = require('../../middlewares/rateLimit');
const { rewriteSchema, listQuerySchema, idParamSchema } = require('./rewrite.schema');
const rewriteController = require('./rewrite.controller');

const router = Router();

// Todo el módulo exige sesión: cada reescritura cuesta dinero y se imputa a un usuario.
router.use(authenticate);

router.get('/', validate({ query: listQuerySchema }), rewriteController.list);
router.get('/:id', validate({ params: idParamSchema }), rewriteController.detail);
router.post('/', rewriteLimiter, validate({ body: rewriteSchema }), rewriteController.create);

module.exports = router;
