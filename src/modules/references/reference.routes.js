'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const { syncBodySchema, listQuerySchema } = require('./reference.schema');
const referenceController = require('./reference.controller');

const router = Router();

/**
 * Todo el módulo es del administrador.
 *
 * El corpus no se expone en abierto: al comprador le llegan las fuentes por el
 * conector, filtradas por la licencia que pagó, y de una en una según lo que
 * pregunte. Publicar la biblioteca entera sería regalar el trabajo de curarla.
 */
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/estado', referenceController.status);
router.get('/', validate({ query: listQuerySchema }), referenceController.list);
router.post('/sincronizar', validate({ body: syncBodySchema }), referenceController.sync);

module.exports = router;
