'use strict';

const { Prisma } = require('@prisma/client');
const env = require('../config/env');
const logger = require('../config/logger');
const { AppError } = require('../shared/errors/AppError');
const { ERROR_CODES } = require('../config/constants');

/** Traduce errores conocidos de Prisma a errores HTTP con sentido. */
function fromPrisma(error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      return { statusCode: 409, code: ERROR_CODES.INTERNAL_ERROR, message: 'El registro ya existe.' };
    }
    if (error.code === 'P2025') {
      return { statusCode: 404, code: ERROR_CODES.NOT_FOUND, message: 'Recurso no encontrado.' };
    }
  }
  return null;
}

// Express identifica el manejador de errores por su aridad de 4 argumentos.
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, _next) {
  let statusCode = 500;
  let code = ERROR_CODES.INTERNAL_ERROR;
  let message = 'Ocurrió un error inesperado.';
  let details;

  if (error instanceof AppError) {
    ({ statusCode, code, message, details } = error);
  } else {
    const mapped = fromPrisma(error);
    if (mapped) ({ statusCode, code, message } = mapped);
  }

  // 5xx: siempre con traza. 4xx: ruido esperable, nivel warn.
  const log = statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log(
    { err: error, statusCode, code, method: req.method, url: req.originalUrl, userId: req.user?.id },
    message,
  );

  const payload = { success: false, error: { code, message } };
  if (details) payload.error.details = details;
  // La traza solo fuera de producción, para no filtrar rutas ni dependencias.
  if (!env.isProduction && statusCode >= 500) payload.error.stack = error.stack;

  res.status(statusCode).json(payload);
}

module.exports = errorHandler;
