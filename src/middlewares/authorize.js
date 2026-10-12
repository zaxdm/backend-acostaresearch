'use strict';

const { ForbiddenError, UnauthorizedError } = require('../shared/errors/AppError');
const { ROLES } = require('../config/constants');
const env = require('../config/env');
const { abiertaAlPais, alcanceDe } = require('./panelDePais');

/**
 * RBAC: restringe la ruta a los roles indicados. Debe ir después de `authenticate`.
 * Uso: router.get('/usuarios', authenticate, authorize(ROLES.ADMIN), handler)
 *
 * Un administrador de país (ADMIN_PAIS) pasa por las rutas de ADMIN solo si
 * están en la lista de `panelDePais`. En las que pasa, y en todas las del
 * dueño, queda `req.alcance` con el país que hay que aplicar.
 */
function authorize(...allowedRoles) {
  return function authorizeMiddleware(req, _res, next) {
    if (!req.user) {
      return next(new UnauthorizedError('Se requiere autenticación.'));
    }

    if (req.user.role === ROLES.ADMIN_PAIS && allowedRoles.includes(ROLES.ADMIN)) {
      const ruta = `${req.baseUrl}${req.path}`;
      const sinPrefijo = ruta.startsWith(env.API_PREFIX) ? ruta.slice(env.API_PREFIX.length) : ruta;
      // Sin país no hay nada que enseñarle: mejor fuera que viéndolo todo.
      if (!req.user.pais || !abiertaAlPais(req.method, sinPrefijo)) {
        return next(new ForbiddenError('Tu rol no permite acceder a este recurso.'));
      }
      req.alcance = alcanceDe(req.user);
      return next();
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError('Tu rol no permite acceder a este recurso.'));
    }
    // Se lee aquí, antes de `validate`, que se queda solo con lo que conoce el
    // esquema de cada ruta y tiraría el `?pais=`.
    req.alcance = alcanceDe(req.user, req.query);
    return next();
  };
}

module.exports = authorize;
