'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { ERROR_CODES } = require('../config/constants');

function build({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // En desarrollo estorba más de lo que protege.
    skip: () => env.isDevelopment,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        error: { code: ERROR_CODES.TOO_MANY_REQUESTS, message },
      }),
  });
}

/** Límite general de la API. */
const globalLimiter = build({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Demasiadas peticiones. Inténtalo de nuevo en unos minutos.',
});

/** Límite estricto para endpoints que se prestan a fuerza bruta. */
const authLimiter = build({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.',
});

/** Límite para reenvío de correos, que además cuesta dinero. */
const emailLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Has solicitado demasiados correos. Inténtalo más tarde.',
});

module.exports = { globalLimiter, authLimiter, emailLimiter };
