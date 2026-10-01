'use strict';

const pino = require('pino');
const env = require('./env');
const { crearVigiaDeErrores, mensajeDeLlamada } = require('../lib/vigiaErrores');

/** Nivel de pino desde el que se avisa al móvil: error (50) y fatal (60). */
const NIVEL_ERROR = 50;

// Solo en producción: en local y en las pruebas los errores se ven en consola.
// `notify` se pide al avisar y no aquí, porque `notify` usa este logger.
const vigia = env.isProduction
  ? crearVigiaDeErrores({ avisar: (aviso) => require('../lib/notify').avisarAlProgramador(aviso) })
  : null;
vigia?.vigilarResumen();

const logger = pino({
  level: env.LOG_LEVEL,
  hooks: {
    logMethod(args, method, nivel) {
      if (vigia && nivel >= NIVEL_ERROR) vigia.registrar(mensajeDeLlamada(args));
      return method.apply(this, args);
    },
  },
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  // Nunca registrar credenciales ni tokens, ni siquiera en debug.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[REDACTADO]',
  },
});

module.exports = logger;
