'use strict';

const { NotFoundError } = require('../shared/errors/AppError');

function notFound(req, _res, next) {
  next(new NotFoundError(`La ruta ${req.method} ${req.originalUrl} no existe.`));
}

module.exports = notFound;
