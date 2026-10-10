'use strict';

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('../shared/utils/tokens');
const { UnauthorizedError, ForbiddenError } = require('../shared/errors/AppError');
const prisma = require('../lib/prisma');
const { ERROR_CODES } = require('../config/constants');

/**
 * Exige un access token válido en `Authorization: Bearer <token>`.
 * Comprueba el estado y la versión de sesión en la BD en cada petición.
 */
async function authenticate(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new UnauthorizedError('Falta el token de acceso.'));
  }

  try {
    const payload = verifyAccessToken(token);
    if (payload.typ !== 'access') {
      return next(new UnauthorizedError('Tipo de token incorrecto.', ERROR_CODES.INVALID_TOKEN));
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, email: true, status: true, sessionVersion: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      return next(new ForbiddenError('La cuenta no está activa.', ERROR_CODES.ACCOUNT_SUSPENDED));
    }
    if ((payload.sessionVersion ?? 0) !== user.sessionVersion || payload.role !== user.role) {
      return next(new UnauthorizedError('La sesión fue invalidada. Inicia sesión de nuevo.', ERROR_CODES.INVALID_TOKEN));
    }
    req.user = { id: user.id, role: user.role, email: user.email };
    return next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      // El frontend usa este código para disparar el refresh y reintentar.
      return next(new UnauthorizedError('El token de acceso expiró.', ERROR_CODES.TOKEN_EXPIRED));
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return next(new UnauthorizedError('Token de acceso inválido.', ERROR_CODES.INVALID_TOKEN));
    }
    return next(error);
  }
}

module.exports = authenticate;
