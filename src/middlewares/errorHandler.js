'use strict';

const { Prisma } = require('@prisma/client');
const env = require('../config/env');
const logger = require('../config/logger');
const { AppError } = require('../shared/errors/AppError');
const { ERROR_CODES } = require('../config/constants');
const { avisarAlAdmin } = require('../lib/notify');
const { esCaidaDeBase, crearDetector, UMBRAL } = require('../lib/dbAlert');

/**
 * Segundos que se le piden al cliente antes de reintentar.
 *
 * Los cortes medidos duran unos cuatro minutos, así que treinta segundos no
 * acierta el final: acierta el ritmo al que conviene volver a preguntar sin
 * castigar a una base que está intentando levantarse.
 */
const REINTENTAR_EN_S = 30;

const registrarFallo = crearDetector();

/** Traduce errores conocidos de Prisma a errores HTTP con sentido. */
function fromPrisma(error) {
  // Primero lo que no es culpa de la consulta sino del enlace con la base. Se
  // mira el código suelto, sin exigir el tipo: la misma avería llega como
  // PrismaClientKnownRequestError si ya había cliente y como
  // PrismaClientInitializationError si el corte pilló al arranque.
  if (esCaidaDeBase(error)) {
    return {
      statusCode: 503,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      // Un 500 le dice al frontend «aquí hay un fallo que alguien tiene que
      // arreglar»; esto es lo contrario: no hay nada que arreglar en la
      // petición, solo que volver a intentarlo dentro de un momento.
      message: 'El servicio no está disponible en este momento. Inténtalo de nuevo en unos segundos.',
    };
  }

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

/**
 * Avisa al administrador si los cortes se acumulan.
 *
 * Va envuelto en su propio try porque esto es el último muro de la aplicación:
 * si el manejador de errores lanza, Express responde con su página en blanco y
 * el error original se pierde. Ningún aviso vale eso.
 */
function avisarSiLaBaseSeCayo(error) {
  try {
    if (!esCaidaDeBase(error) || !registrarFallo()) return;

    avisarAlAdmin({
      titulo: 'La base de datos no responde',
      mensaje:
        `${UMBRAL} fallos de conexión en menos de un minuto (${error.code}). ` +
        'La API está devolviendo 503 a quien entre.',
      etiquetas: ['rotating_light'],
      prioridad: 5,
    });
  } catch (fallo) {
    logger.error({ err: fallo }, 'No se pudo evaluar el aviso de caída de la base');
  }
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

  avisarSiLaBaseSeCayo(error);

  // 5xx: siempre con traza. 4xx: ruido esperable, nivel warn.
  const log = statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log(
    { err: error, statusCode, code, method: req.method, url: req.originalUrl, userId: req.user?.id },
    message,
  );

  if (statusCode === 503) res.set('Retry-After', String(REINTENTAR_EN_S));

  const payload = { success: false, error: { code, message } };
  if (details) payload.error.details = details;
  // La traza solo fuera de producción, para no filtrar rutas ni dependencias.
  if (!env.isProduction && statusCode >= 500) payload.error.stack = error.stack;

  res.status(statusCode).json(payload);
}

module.exports = errorHandler;
