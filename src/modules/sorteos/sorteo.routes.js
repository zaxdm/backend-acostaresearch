'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { sorteoLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  slugParamSchema,
  idParamSchema,
  participanteParamSchema,
  inscripcionSchema,
  crearSchema,
  cambiarSchema,
} = require('./sorteo.schema');
const sorteoController = require('./sorteo.controller');

const router = Router();

// Públicas: quien se apunta no tiene cuenta. Solo se llega con el enlace.
router.get('/publico/:slug', validate({ params: slugParamSchema }), sorteoController.verPublico);
router.post(
  '/publico/:slug',
  sorteoLimiter,
  validate({ params: slugParamSchema, body: inscripcionSchema }),
  sorteoController.inscribir,
);

// De aquí abajo, solo el administrador.
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/', sorteoController.listar);
router.post('/', validate({ body: crearSchema }), sorteoController.crear);
router.get('/:id', validate({ params: idParamSchema }), sorteoController.ver);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: cambiarSchema }),
  sorteoController.cambiar,
);
router.delete('/:id', validate({ params: idParamSchema }), sorteoController.borrar);
router.post('/:id/sortear', validate({ params: idParamSchema }), sorteoController.sortear);
router.delete(
  '/:id/participantes/:participanteId',
  validate({ params: participanteParamSchema }),
  sorteoController.quitarParticipante,
);

module.exports = router;
