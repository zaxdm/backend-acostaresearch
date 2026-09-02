'use strict';

const jwt = require('jsonwebtoken');
const { verifyAccessToken } = require('../shared/utils/tokens');
const { UnauthorizedError } = require('../shared/errors/AppError');
const { ERROR_CODES } = require('../config/constants');

/**
 * Exige un access token válido en `Authorization: Bearer <token>`.
 * Deja en `req.user` el sujeto autenticado; no consulta la BD (el token basta).
 */
function authenticate(req, _res, next) {
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

    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    return next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      // El frontend usa este código para disparar el refresh y reintentar.
      return next(new UnauthorizedError('El token de acceso expiró.', ERROR_CODES.TOKEN_EXPIRED));
    }
    return next(new UnauthorizedError('Token de acceso inválido.', ERROR_CODES.INVALID_TOKEN));
  }
}

module.exports = authenticate;
