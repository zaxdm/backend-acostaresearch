'use strict';

const crypto = require('node:crypto');
const { Router } = require('express');
const env = require('../../config/env');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const { crearAccesoSchema, revocarAccesoSchema } = require('./acostaia.schema');
const acostaiaService = require('./acostaia.service');

const router = Router();

function coincide(recibido, esperado) {
  const a = Buffer.from(recibido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Solo el servidor de AcostaIA: trae la clave compartida en
 * `Authorization: Bearer`. Sin `ACOSTAIA_CLAVE_INTERNA` en el .env la ruta
 * está cerrada para todos.
 */
function soloAcostaIA(req, res, next) {
  const cabecera = req.get('Authorization') ?? '';
  const clave = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';

  if (!env.ACOSTAIA_CLAVE_INTERNA || !coincide(clave, env.ACOSTAIA_CLAVE_INTERNA)) {
    return res
      .status(401)
      .json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No autorizado.' } });
  }
  return next();
}

router.use(soloAcostaIA);

/** POST /acostaia/accesos — licencia nueva de un producto para un usuario de AcostaIA. */
router.post(
  '/accesos',
  validate({ body: crearAccesoSchema }),
  asyncHandler(async (req, res) => created(res, await acostaiaService.crearAcceso(req.body))),
);

/** POST /acostaia/accesos/revocar — corta sus licencias (de un producto o todas). */
router.post(
  '/accesos/revocar',
  validate({ body: revocarAccesoSchema }),
  asyncHandler(async (req, res) => ok(res, await acostaiaService.revocarAcceso(req.body))),
);

module.exports = router;
