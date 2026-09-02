'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const { listQuerySchema } = require('./user.schema');
const userController = require('./user.controller');

const router = Router();

// A partir de aquí, todas las rutas exigen un access token válido.
router.use(authenticate);

router.get('/me', userController.me);
router.get('/', authorize(ROLES.ADMIN), validate({ query: listQuerySchema }), userController.list);

module.exports = router;
