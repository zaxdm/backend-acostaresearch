'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const { mendeleySyncLimiter, mendeleyConectarLimiter } = require('../../middlewares/rateLimit');
const { elegirCarpetaSchema, vueltaSchema } = require('./mendeley.schema');
const mendeleyController = require('./mendeley.controller');

const router = Router();

/**
 * La vuelta desde mendeley.com va ANTES del `authenticate` y sin él, por lo
 * mismo que la de Zotero: llega de otro dominio y la cookie de sesión puede no
 * viajar. La identidad sale de la fila del `state`, que se borra al usarse.
 */
router.get('/vuelta', validate({ query: vueltaSchema }), mendeleyController.vuelta);

router.use(authenticate);

router.get('/estado', mendeleyController.estado);
router.post('/conectar', mendeleyConectarLimiter, mendeleyController.conectar);
router.get('/carpetas', mendeleyConectarLimiter, mendeleyController.carpetas);
router.put(
  '/carpeta',
  mendeleySyncLimiter,
  validate({ body: elegirCarpetaSchema }),
  mendeleyController.elegir,
);
router.post('/sincronizar', mendeleySyncLimiter, mendeleyController.sincronizar);
router.delete('/', mendeleyController.desconectar);

module.exports = router;
