'use strict';

const express = require('express');
const { Router } = express;
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { resenaLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const env = require('../../config/env');
const {
  resenaBodySchema,
  altaDelPanelSchema,
  revisionSchema,
  idParamSchema,
  adminQuerySchema,
  publicasQuerySchema,
} = require('./resena.schema');
const resenaController = require('./resena.controller');

const router = Router();

/**
 * El video va en crudo, como el PDF de las guías: es un solo archivo y
 * `multipart` añadiría una dependencia para conseguir lo mismo. El techo lo
 * pone el entorno, y aquí se deja un poco de aire para que quien se pase reciba
 * el mensaje del servicio —«el tope son 80 MB»— en vez de un corte seco.
 */
const video = express.raw({
  type: () => true,
  limit: env.RESENA_VIDEO_MAX_BYTES + 1024 * 1024,
});

// Leerlas es público: están para quien todavía no ha comprado. El video de una
// reseña aprobada, también: lo pide la etiqueta `<video>` de la portada, que no
// manda la sesión de nadie. Va antes de `/mia` porque `/mia/video` es más
// específico y tiene que ganar.
router.get('/', validate({ query: publicasQuerySchema }), resenaController.publicas);

// Escribirlas, no: hay que tener cuenta. Es lo que impide que una tarde de
// aburrimiento llene el panel de opiniones de nadie. Van antes que `/:id/video`
// para que «mias» no se lea como el identificador de una reseña.
// Las suyas son varias, así que cada una se toca por su id. Todas estas rutas
// comprueban que la reseña sea de quien la pide Y que no sea una de las que
// publicamos nosotros a su nombre.
router.get('/mias', authenticate, resenaController.mias);
router.get(
  '/mias/:id/video',
  authenticate,
  validate({ params: idParamSchema }),
  resenaController.verMiVideo,
);
router.post(
  '/',
  authenticate,
  resenaLimiter,
  validate({ body: resenaBodySchema }),
  resenaController.guardar,
);
router.put(
  '/mias/:id',
  authenticate,
  resenaLimiter,
  validate({ params: idParamSchema, body: resenaBodySchema }),
  resenaController.cambiar,
);
router.put(
  '/mias/:id/video',
  authenticate,
  resenaLimiter,
  validate({ params: idParamSchema }),
  video,
  resenaController.subirMiVideo,
);
router.delete(
  '/mias/:id/video',
  authenticate,
  validate({ params: idParamSchema }),
  resenaController.quitarMiVideo,
);

// El video de una aprobada, sin sesión.
router.get('/:id/video', validate({ params: idParamSchema }), resenaController.verVideo);

// De aquí abajo, solo el administrador. Va después de las de arriba a
// propósito: `router.use` con authorize alcanza a todo lo que se monte después.
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/panel', validate({ query: adminQuerySchema }), resenaController.listar);
router.post('/panel', validate({ body: altaDelPanelSchema }), resenaController.crear);
router.get(
  '/panel/:id/video',
  validate({ params: idParamSchema }),
  resenaController.verVideoDelPanel,
);
router.put(
  '/panel/:id/video',
  validate({ params: idParamSchema }),
  video,
  resenaController.subirVideo,
);
router.patch(
  '/panel/:id',
  validate({ params: idParamSchema, body: revisionSchema }),
  resenaController.revisar,
);

// Borrarla del todo. Va aquí abajo y solo para el administrador: ni su propio
// autor la borra, que una reseña publicada no se retira sin que lo sepa quien
// la publicó.
router.delete('/panel/:id', validate({ params: idParamSchema }), resenaController.borrar);

module.exports = router;
