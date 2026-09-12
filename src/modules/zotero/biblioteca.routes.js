'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const { zoteroSyncLimiter } = require('../../middlewares/rateLimit');
const { elegirColeccionSchema, vueltaSchema } = require('./biblioteca.schema');
const bibliotecaController = require('./biblioteca.controller');

const router = Router();

/**
 * La vuelta desde zotero.org va ANTES del `authenticate`, y sin él.
 *
 * Quien llega aquí es el navegador del tesista siguiendo una redirección desde
 * otro dominio, y esa navegación puede no traer su cookie de sesión. Pedirle
 * sesión sería mandarlo a la pantalla de entrar justo después de haber
 * autorizado, y perder el intercambio.
 *
 * No queda abierto por eso: la identidad sale de la fila que se guardó al
 * empezar el intercambio, que se borra al usarse y caduca en dos horas. Sin un
 * token válido y sin estrenar, esta ruta no hace nada.
 */
router.get('/vuelta', validate({ query: vueltaSchema }), bibliotecaController.vuelta);

router.use(authenticate);

router.get('/estado', bibliotecaController.estado);
router.post('/conectar', zoteroSyncLimiter, bibliotecaController.conectar);
router.get('/colecciones', zoteroSyncLimiter, bibliotecaController.colecciones);
router.put(
  '/coleccion',
  zoteroSyncLimiter,
  validate({ body: elegirColeccionSchema }),
  bibliotecaController.elegir,
);
router.post('/sincronizar', zoteroSyncLimiter, bibliotecaController.sincronizar);
router.delete('/', bibliotecaController.desconectar);

module.exports = router;
