'use strict';
const { Router } = require('express');
const { z } = require('zod');
const db = require('../../lib/prisma');
const asyncHandler = require('../../shared/http/asyncHandler');
const validate = require('../../middlewares/validate');
const { ok } = require('../../shared/http/apiResponse');
const { readRefreshCookie } = require('../../shared/utils/cookies');
const { hashToken } = require('../../shared/utils/tokens');
const { UnauthorizedError, ConflictError } = require('../../shared/errors/AppError');
const push = require('./social.push');

// Se monta dentro del router admin, después de authenticate + authorize(ADMIN).
const router = Router();
const body = z.object({ token: z.string().min(20).max(4096).regex(/^[A-Za-z0-9_:.-]+$/) }).strict();
router.put('/dispositivos', validate({ body }), asyncHandler(async (req, res) => {
  if (!push.habilitado()) throw new ConflictError('Las notificaciones aún necesitan configurar Firebase.');
  const raw = readRefreshCookie(req);
  if (!raw) throw new UnauthorizedError('Inicia sesión de nuevo para activar las notificaciones.');
  const session = await db.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!session || session.userId !== req.user.id || session.revokedAt || session.expiresAt <= new Date()) {
    throw new UnauthorizedError('La sesión ya no está activa.');
  }
  const tokenHash = push.hashToken(req.body.token);
  const data = { token: req.body.token, userId: req.user.id, familyId: session.familyId,
    sessionVersion: session.sessionVersion };
  await db.socialDispositivo.upsert({ where: { tokenHash }, create: { tokenHash, ...data }, update: data });
  return ok(res, { registrado: true });
}));
router.delete('/dispositivos', validate({ body }), asyncHandler(async (req, res) => {
  await db.socialDispositivo.deleteMany({ where: { tokenHash: push.hashToken(req.body.token), userId: req.user.id } });
  return ok(res, { eliminado: true });
}));
module.exports = router;
