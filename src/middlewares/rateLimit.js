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

/**
 * Límite para los endpoints que se prestan a fuerza bruta.
 *
 * Treinta por cuarto de hora y por IP. No son treinta por persona: en Perú es
 * habitual que un operador saque a muchos abonados por la misma IP pública, así
 * que un número bajo aquí bloquea a gente que no ha hecho nada. Diez se quedaba
 * corto incluso para una sola persona que se equivoque al teclear.
 */
const authLimiter = build({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.',
});

/** Límite para reenvío de correos, que además cuesta dinero. */
const emailLimiter = build({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Has solicitado demasiados correos. Inténtalo más tarde.',
});

/** Cada reescritura es una llamada de pago: se frena el abuso por ráfagas. */
const rewriteLimiter = build({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Estás enviando reescrituras demasiado rápido. Espera un momento.',
});

/** Abrir órdenes de pago es barato para nosotros, pero ensucia la pasarela. */
const paymentLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: 'Has abierto demasiados pagos seguidos. Espera unos minutos.',
});

/**
 * Recoger un conector de un enlace de prueba.
 *
 * Holgado a propósito: un taller entero sale a internet por la wifi de la
 * universidad, con UNA sola IP, y los treinta pulsan en el mismo minuto. Esto no
 * protege los cupos —de eso se ocupa el tope del enlace—, solo frena a un script
 * que vacíe enlaces a ráfagas.
 */
const trialClaimLimiter = build({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: 'Se han pedido demasiados conectores desde esta conexión. Espera unos minutos.',
});

/**
 * Límite del conector MCP, contado POR LICENCIA y no por IP.
 *
 * Es obligatorio que sea así: Claude llama desde la infraestructura de
 * Anthropic, de modo que todos los compradores llegan con la misma dirección.
 * Un límite por IP los metería a todos en el mismo cubo y el primero que
 * trabajara mucho dejaría fuera a los demás.
 */
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.params.token ?? 'sin-token',
  skip: () => env.isDevelopment,
  handler: (_req, res) =>
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Demasiadas consultas seguidas. Espera un momento.' },
      id: null,
    }),
});

module.exports = {
  globalLimiter,
  authLimiter,
  emailLimiter,
  rewriteLimiter,
  paymentLimiter,
  trialClaimLimiter,
  mcpLimiter,
};
