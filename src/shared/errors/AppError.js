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

/**
 * Datos que no valen, con statusCode 422.
 *
 * ADMITE LAS DOS FORMAS DE LLAMARLO, y no por comodidad.
 *
 * Nació para el middleware de validación, que tiene una LISTA de problemas por
 * campo y ningún mensaje que escribir, así que `details` quedó primero. Pero
 * casi todo el que lo usa a mano tiene lo contrario: una sola frase escrita para
 * que la lea una persona —«eso es un .doc antiguo, guárdalo como .docx»— y
 * ningún detalle por campo.
 *
 * Esos escribían `new ValidationError('su frase')` y la frase aterrizaba en
 * `details`, donde nadie la lee: al tesista le salía «Los datos enviados no son
 * válidos», que no dice qué pasó ni qué hacer. Siete sitios del código lo hacían
 * —había hasta un comentario prometiendo que el mensaje «se pasa tal cual»— y
 * ninguno fallaba de forma visible: el error salía, solo que mudo.
 *
 * Se arregla aquí y no en los siete porque la firma era la trampa. Una cadena
 * suelta es un mensaje; un array o un objeto son detalles.
 */
class ValidationError extends AppError {
  constructor(detallesOMensaje, message) {
    const esMensaje = typeof detallesOMensaje === 'string';

    super(message ?? (esMensaje ? detallesOMensaje : 'Los datos enviados no son válidos.'), {
      statusCode: 422,
      code: ERROR_CODES.VALIDATION_ERROR,
      details: esMensaje ? undefined : detallesOMensaje,
    });
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
