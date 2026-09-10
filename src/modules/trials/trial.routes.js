'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { trialClaimLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  createTrialSchema,
  updateTrialSchema,
  idParamSchema,
  slugParamSchema,
} = require('./trial.schema');
const trialController = require('./trial.controller');

const router = Router();

// ── Lo público: la página que se comparte con el grupo ─────────────────────
//
// Sin sesión, que es todo el sentido: quien recibe el enlace no se registra.
// Lo único que protege los cupos es que el enlace no se puede adivinar y que
// tiene tope; el límite de ráfaga solo frena a un script.
router.get('/enlace/:slug', validate({ params: slugParamSchema }), trialController.publicInfo);
router.post(
  '/enlace/:slug/conector',
  trialClaimLimiter,
  validate({ params: slugParamSchema }),
  trialController.claim,
);

// ── Lo del administrador ───────────────────────────────────────────────────
router.use(authenticate, authorize(ROLES.ADMIN));

router.get('/', trialController.list);
router.post('/', validate({ body: createTrialSchema }), trialController.create);
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateTrialSchema }),
  trialController.update,
);
router.delete('/:id', validate({ params: idParamSchema }), trialController.remove);
router.get('/:id/invitados', validate({ params: idParamSchema }), trialController.guests);

module.exports = router;
