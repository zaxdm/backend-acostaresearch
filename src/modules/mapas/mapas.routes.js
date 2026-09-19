'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const { mapasLimiter } = require('../../middlewares/rateLimit');
const { mapaSchema } = require('./mapas.schema');
const mapasController = require('./mapas.controller');

const router = Router();

/**
 * Los mapas bibliométricos de cada comprador, para VOSviewer.
 *
 * Montado en `/mis-mapas`, como sus hermanas `/mis-fuentes` y `/mi-scopus`:
 * el prefijo dice de quién es lo que cuelga. No se guarda nada: el mapa se
 * calcula cada vez y el tesista se lleva los archivos.
 */
router.use(authenticate);

/**
 * Un mapa de cualquiera de los análisis de VOSviewer. `/coocurrencia` es el
 * nombre con el que nació, cuando solo había ese: se deja para la web que ya
 * está publicada, que manda sin `analisis` y recibe una coocurrencia.
 */
router.post('/mapa', mapasLimiter, validate({ body: mapaSchema }), mapasController.mapa);
router.post('/coocurrencia', mapasLimiter, validate({ body: mapaSchema }), mapasController.coocurrencia);

module.exports = router;
