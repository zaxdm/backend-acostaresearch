'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { embudoLimiter } = require('../../middlewares/rateLimit');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, noContent } = require('../../shared/http/apiResponse');
const { verifyAccessToken } = require('../../shared/utils/tokens');
const { ROLES } = require('../../config/constants');
const embudoService = require('./embudo.service');

const router = Router();

const visitaSchema = z.object({
  // Un UUID que genera el navegador y guarda. Nada que identifique a nadie.
  visitante: z.string().uuid(),
  pagina: z.enum(embudoService.PAGINAS),
  origen: z
    .string()
    .trim()
    .max(60)
    .regex(/^[\w .-]*$/)
    .optional()
    .transform((valor) => valor || null),
});

const resumenSchema = z.object({
  dias: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * Quién es, si trae sesión. La visita no la exige —la ve cualquiera—, así que
 * un token caducado o ausente no es un error: simplemente no se apunta.
 */
function usuarioSiLoHay(req) {
  const [esquema, token] = (req.get('authorization') ?? '').split(' ');
  if (esquema !== 'Bearer' || !token) return null;
  try {
    const payload = verifyAccessToken(token);
    return payload.typ === 'access' ? payload.sub : null;
  } catch {
    return null;
  }
}

// Público: /planes lo manda al abrirse, tenga o no cuenta quien mira. Responde
// 204 pase lo que pase con la base, para no ensuciar la consola del visitante.
router.post(
  '/visita',
  embudoLimiter,
  validate({ body: visitaSchema }),
  asyncHandler(async (req, res) => {
    await embudoService.registrarVisita({ ...req.body, userId: usuarioSiLoHay(req) });
    return noContent(res);
  }),
);

router.get(
  '/',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ query: resumenSchema }),
  asyncHandler(async (req, res) => ok(res, await embudoService.resumen({ dias: req.query.dias }))),
);

module.exports = router;
