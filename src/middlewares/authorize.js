'use strict';

const { ForbiddenError, UnauthorizedError } = require('../shared/errors/AppError');

/**
 * RBAC: restringe la ruta a los roles indicados. Debe ir después de `authenticate`.
 * Uso: router.get('/usuarios', authenticate, authorize(ROLES.ADMIN), handler)
 */
function authorize(...allowedRoles) {
  return function authorizeMiddleware(req, _res, next) {
    if (!req.user) {
      return next(new UnauthorizedError('Se requiere autenticación.'));
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError('Tu rol no permite acceder a este recurso.'));
    }
    return next();
  };
}

module.exports = authorize;
