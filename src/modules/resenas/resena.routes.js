'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { resenaLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  resenaBodySchema,
  revisionSchema,
  idParamSchema,
  adminQuerySchema,
  publicasQuerySchema,
} = require('./resena.schema');
const resenaController = require('./resena.controller');

const router = Router();

// Leerlas es público: están para quien todavía no ha comprado.
router.get('/', validate({ query: publicasQuerySchema }), resenaController.publicas);

// Escribirlas, no: hay que tener cuenta. Es lo que impide que una tarde de
// aburrimiento llene el panel de opiniones de nadie.
router.get('/mia', authenticate, resenaController.mia);
router.post(
  '/',
  authenticate,
  resenaLimiter,
  validate({ body: resenaBodySchema }),
  resenaController.guardar,
);

// De aquí abajo, solo el administrador. Va después de las de arriba a
// propósito: `router.use` con authorize alcanza a todo lo que se monte después.
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/panel', validate({ query: adminQuerySchema }), resenaController.listar);
router.patch(
  '/panel/:id',
  validate({ params: idParamSchema, body: revisionSchema }),
  resenaController.revisar,
);

module.exports = router;
