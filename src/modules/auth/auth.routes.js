'use strict';

const { Router } = require('express');
const validate = require('../../middlewares/validate');
const authenticate = require('../../middlewares/authenticate');
const { authLimiter, emailLimiter } = require('../../middlewares/rateLimit');
const {
  registerSchema,
  loginSchema,
  verifyEmailSchema,
  resendVerificationSchema,
} = require('./auth.schema');
const authController = require('./auth.controller');

const router = Router();

router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);

// Se autentica con la cookie httpOnly, no con el access token.
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);

router.post('/verify-email', authLimiter, validate({ body: verifyEmailSchema }), authController.verifyEmail);
router.post(
  '/resend-verification',
  emailLimiter,
  validate({ body: resendVerificationSchema }),
  authController.resendVerification,
);

module.exports = router;
