'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { asesorLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  postulacionBodySchema,
  slugParamSchema,
  idParamSchema,
  revisionSchema,
  convocatoriaSchema,
  convocatoriaCambioSchema,
} = require('./asesor.schema');
const asesorController = require('./asesor.controller');

const router = Router();

/*
 * Las públicas van primero y con nombre propio —`/convocatoria/...`— para no
 * chocar con las del administrador, que cuelgan de la raíz. Sin sesión a
 * propósito: quien postula todavía no tiene cuenta, y no se le va a pedir que
 * se registre para dejar su ficha.
 */
router.get('/convocatoria/publica', asesorController.publica);
router.get(
  '/convocatoria/:slug',
  validate({ params: slugParamSchema }),
  asesorController.verConvocatoria,
);
router.post(
  '/convocatoria/:slug',
  asesorLimiter,
  validate({ params: slugParamSchema, body: postulacionBodySchema }),
  asesorController.postular,
);

router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/convocatorias', asesorController.convocatorias);
router.post(
  '/convocatorias',
  validate({ body: convocatoriaSchema }),
  asesorController.crearConvocatoria,
);
router.patch(
  '/convocatorias/:id',
  validate({ params: idParamSchema, body: convocatoriaCambioSchema }),
  asesorController.cambiarConvocatoria,
);

router.get('/', asesorController.listar);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: revisionSchema }),
  asesorController.revisar,
);

module.exports = router;
