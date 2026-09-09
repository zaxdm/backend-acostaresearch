'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const projectService = require('./project.service');

const router = Router();

/**
 * El proyecto es de quien lo escribe.
 *
 * Todas las rutas trabajan sobre `req.user.id` y ninguna acepta de quién por
 * parámetro. Un identificador de usuario que viaje en la petición es la forma
 * más rápida de acabar enseñando la tesis de otro — y aquí, además de fuentes,
 * hay lo que alguien ha decidido sobre su propia investigación.
 */
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await projectService.deUsuario(req.user.id))),
);

module.exports = router;
