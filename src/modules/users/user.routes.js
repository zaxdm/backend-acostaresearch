'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { authLimiter, emailLimiter } = require('../../middlewares/rateLimit');
const { ROLES } = require('../../config/constants');
const {
  listQuerySchema,
  updateProfileSchema,
  changePasswordSchema,
  createAdminSchema,
} = require('./user.schema');
const userController = require('./user.controller');

const router = Router();

// A partir de aquí, todas las rutas exigen un access token válido.
router.use(authenticate);

// ── La propia cuenta ───────────────────────────────────────────────────────
router.get('/me', userController.me);
router.patch('/me', validate({ body: updateProfileSchema }), userController.updateMe);

// Pedir el código pasa por el limitador de correo: cada llamada manda un email,
// y sin freno esto es una forma cómoda de inundar una bandeja ajena.
router.post('/me/password/code', emailLimiter, userController.requestPasswordCode);

// Y probarlo pasa por el de ráfagas: son 6 dígitos, y aunque cada código muera a
// los 5 fallos, sin freno se podrían quemar códigos nuevos en bucle.
router.post(
  '/me/password',
  authLimiter,
  validate({ body: changePasswordSchema }),
  userController.changePassword,
);

// ── Administración ─────────────────────────────────────────────────────────
router.post(
  '/admins',
  authorize(ROLES.ADMIN),
  validate({ body: createAdminSchema }),
  userController.createAdmin,
);
router.get('/', authorize(ROLES.ADMIN), validate({ query: listQuerySchema }), userController.list);

module.exports = router;
