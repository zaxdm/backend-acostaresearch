'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const {
  scopusBuscarLimiter,
  scopusConectarLimiter,
  scopusIaLimiter,
} = require('../../middlewares/rateLimit');
const {
  buscarSchema,
  consultaSchema,
  importarSchema,
  resumenesSchema,
  resumirSchema,
  vueltaSchema,
} = require('./scopus.schema');
const scopusController = require('./scopus.controller');

const router = Router();

/**
 * El Scopus de cada comprador.
 *
 * MONTADO EN `/mi-scopus`, Y NO EN `/api/v1/scopus`
 * ------------------------------------------------
 * Porque en esta casa el prefijo dice DE QUIÉN es lo que cuelga, y eso importa
 * más que parecerse a la convención de otro sitio. `/referencias` es el corpus
 * de Acosta y lo administra él; `/mis-fuentes` y `/mi-zotero` son de cada
 * comprador. Esto es lo segundo, así que se llama igual que sus hermanas y
 * quien lea la lista de rutas sabe sin abrir nada quién puede llamarlas.
 *
 * La correspondencia con los nombres del encargo, para que no haya que
 * adivinarla:
 *
 *   POST /api/v1/scopus/connect     →  POST   /api/v1/mi-scopus/conectar
 *   GET  /api/v1/scopus/callback    →  GET    /api/v1/mi-scopus/vuelta
 *   GET  /api/v1/scopus/status      →  GET    /api/v1/mi-scopus/estado
 *   POST /api/v1/scopus/search      →  POST   /api/v1/mi-scopus/buscar
 *   POST /api/v1/scopus/import      →  POST   /api/v1/mi-scopus/importar
 *   POST /api/v1/scopus/disconnect  →  DELETE /api/v1/mi-scopus
 *
 * Desconectar va como DELETE y no como POST porque eso es lo que hace —borrar
 * la conexión— y es lo que ya hace la de Zotero.
 */

/**
 * La vuelta desde Elsevier va ANTES del `authenticate`, y sin él.
 *
 * Quien llega aquí es el navegador del tesista siguiendo una redirección desde
 * otro dominio, y esa navegación puede no traer su cookie de sesión. Pedirle
 * sesión sería mandarlo a la pantalla de entrar justo después de haber
 * autorizado, y perder el intercambio.
 *
 * No queda abierto por eso: la identidad sale de la fila que se guardó al
 * empezar, que se borra al usarse y caduca en dos horas, y además tiene que
 * venir con la cookie del navegador que empezó. Sin las dos cosas, esta ruta
 * no hace nada.
 */
router.get('/vuelta', validate({ query: vueltaSchema }), scopusController.vuelta);

router.use(authenticate);

router.get('/estado', scopusController.estado);
router.post('/conectar', scopusConectarLimiter, scopusController.conectar);
router.post(
  '/buscar',
  scopusBuscarLimiter,
  validate({ body: buscarSchema }),
  scopusController.buscar,
);
/**
 * Del tema en español a los conceptos en inglés, con Gemini. No busca: propone,
 * y el tesista revisa antes de pulsar «Buscar». Con su propio límite porque
 * gasta Gemini y no la cuota de Elsevier.
 */
router.post(
  '/generar-consulta',
  scopusIaLimiter,
  validate({ body: consultaSchema }),
  scopusController.generarConsulta,
);
/**
 * El resumen con citas de los artículos de la página: lo que hace la «IA de
 * Scopus». Mismo límite que el generador, porque los dos gastan Gemini.
 */
router.post(
  '/resumir',
  scopusIaLimiter,
  validate({ body: resumirSchema }),
  scopusController.resumir,
);
/**
 * Los resúmenes de la página, de OpenAlex, para «Ver resumen». No toca la
 * cuota de Elsevier; va por el límite de buscar porque es una consulta por
 * página y así nadie la usa para recorrer OpenAlex entero.
 */
router.post(
  '/resumenes',
  scopusBuscarLimiter,
  validate({ body: resumenesSchema }),
  scopusController.resumenes,
);
router.post(
  '/importar',
  scopusBuscarLimiter,
  validate({ body: importarSchema }),
  scopusController.importar,
);
router.delete('/', scopusController.desconectar);

module.exports = router;
