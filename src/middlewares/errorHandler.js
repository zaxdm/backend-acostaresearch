'use strict';

const { Prisma } = require('@prisma/client');
const env = require('../config/env');
const logger = require('../config/logger');
const { AppError } = require('../shared/errors/AppError');
const { ocultarSecretosEnUrl } = require('../shared/utils/ocultar');
const { ERROR_CODES } = require('../config/constants');
const { esCaidaDeBase } = require('../lib/dbAlert');
const { revisarRechazo } = require('../lib/subidaRechazada');

/**
 * Segundos que se le piden al cliente antes de reintentar.
 *
 * Los cortes medidos duran unos cuatro minutos, así que treinta segundos no
 * acierta el final: acierta el ritmo al que conviene volver a preguntar sin
 * castigar a una base que está intentando levantarse.
 */
const REINTENTAR_EN_S = 30;

/** Traduce errores conocidos de Prisma a errores HTTP con sentido. */
function fromPrisma(error) {
  // Primero lo que no es culpa de la consulta sino del enlace con la base. No se
  // exige el tipo: la misma avería llega como PrismaClientKnownRequestError si
  // ya había cliente y como PrismaClientInitializationError si el corte pilló
  // al arranque, cada una con el código en un sitio distinto.
  //
  // El aviso al móvil no sale de aquí sino del vigilante de la base
  // (`lib/vigiaBase.js`), que no depende de que lleguen peticiones.
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

// Express identifica el manejador de errores por su aridad de 4 argumentos.
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, _next) {
  // El navegador cortó la descarga (cerró el video, adelantó, cambió de
  // página): `sendFile` lo entrega como error, pero no falló nada y ya no hay a
  // quién responder. Registrarlo como 500 despertaba al administrador por nada
  // (5 avisos «Ocurrió un error inesperado» con un video de reseña, 30-sep-2026).
  // Se exige que la conexión del navegador esté cerrada: ECONNABORTED también es
  // el código de un tiempo de espera hacia fuera, y eso sí es un error.
  const clienteSeFue = req.aborted || req.socket?.destroyed;
  if (clienteSeFue && (error?.code === 'ECONNABORTED' || error?.code === 'ECONNRESET')) {
    logger.debug({ url: ocultarSecretosEnUrl(req.originalUrl) }, 'El cliente cortó la descarga');
    return;
  }

  let statusCode = 500;
  let code = ERROR_CODES.INTERNAL_ERROR;
  let message = 'Ocurrió un error inesperado.';
  let details;

  if (error instanceof AppError) {
    ({ statusCode, code, message, details } = error);
  } else if (error?.type && Number(error.status) >= 400 && Number(error.status) < 500) {
    // Los de express.raw/json: un archivo que pesa de más o un cuerpo que no se
    // pudo leer. Salían como 500 «Ocurrió un error inesperado», y el tesista
    // que subía un Word de 45 MB no tenía forma de saber qué pasaba.
    statusCode = Number(error.status);
    code = ERROR_CODES.VALIDATION_ERROR;
    message =
      error.type === 'entity.too.large'
        ? 'El archivo pesa demasiado para esta subida.'
        : 'No se pudo leer lo que llegó. Vuelve a intentarlo.';
  } else {
    const mapped = fromPrisma(error);
    if (mapped) ({ statusCode, code, message } = mapped);
  }

  // Un archivo rechazado: al usuario, qué subió y qué se acepta; al
  // administrador, un aviso (ver lib/subidaRechazada). Nunca puede tumbar la respuesta.
  try {
    const propio = revisarRechazo(req, { estado: statusCode, mensaje: message, error });
    if (propio) message = propio;
  } catch (fallo) {
    logger.warn({ err: fallo }, 'No se pudo revisar la subida rechazada');
  }

  // 5xx: siempre con traza. 4xx: ruido esperable, nivel warn.
  const log = statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log(
    {
      err: error,
      statusCode,
      code,
      method: req.method,
      url: ocultarSecretosEnUrl(req.originalUrl),
      userId: req.user?.id,
    },
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
