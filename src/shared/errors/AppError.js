'use strict';

const { ERROR_CODES } = require('../../config/constants');

/**
 * Error de negocio previsible. El manejador global lo traduce a una respuesta
 * JSON estable; cualquier otro error se reporta como 500 sin filtrar detalles.
 */
class AppError extends Error {
  constructor(message, { statusCode = 400, code = ERROR_CODES.INTERNAL_ERROR, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(details, message = 'Los datos enviados no son válidos.') {
    super(message, { statusCode: 422, code: ERROR_CODES.VALIDATION_ERROR, details });
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'No autenticado.', code = ERROR_CODES.UNAUTHENTICATED) {
    super(message, { statusCode: 401, code });
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'No tienes permisos para realizar esta acción.', code = ERROR_CODES.FORBIDDEN) {
    super(message, { statusCode: 403, code });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado.') {
    super(message, { statusCode: 404, code: ERROR_CODES.NOT_FOUND });
  }
}

class ConflictError extends AppError {
  constructor(message, code = ERROR_CODES.INTERNAL_ERROR) {
    super(message, { statusCode: 409, code });
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
