'use strict';

const { ValidationError } = require('../shared/errors/AppError');

/**
 * Valida y NORMALIZA la petición con esquemas Zod. Reemplaza `req.body`,
 * `req.query` y `req.params` por el resultado parseado, de modo que los
 * controladores reciben datos ya saneados y con el tipo correcto.
 */
function validate(schemas) {
  return function validateMiddleware(req, _res, next) {
    const issues = [];

    for (const source of ['body', 'query', 'params']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (result.success) {
        // req.query es un getter en Express 5: se redefine en lugar de asignarse.
        Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
      } else {
        issues.push(
          ...result.error.issues.map((issue) => ({
            field: [source, ...issue.path].join('.'),
            message: issue.message,
          })),
        );
      }
    }

    return issues.length > 0 ? next(new ValidationError(issues)) : next();
  };
}

module.exports = validate;
