'use strict';

const pino = require('pino');
const env = require('./env');

const logger = pino({
  level: env.LOG_LEVEL,
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
