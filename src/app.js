'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');

const env = require('./config/env');
const logger = require('./config/logger');
const routes = require('./routes');
const mcpRouter = require('./modules/mcp/mcp.router');
const { globalLimiter } = require('./middlewares/rateLimit');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

function createApp() {
  const app = express();

  // Detrás de Nginx/Heroku: necesario para que req.ip y las cookies secure funcionen.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Sin Origin (curl, health checks del balanceador) se permite.
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origen no permitido por CORS: ${origin}`));
      },
      credentials: true, // imprescindible para la cookie del refresh token
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // El conector MCP va ANTES del límite global a propósito: ese límite cuenta
  // por IP, y todas las llamadas de Claude llegan desde la misma dirección de
  // Anthropic. Aplicarlo aquí metería a todos los compradores en el mismo cubo.
  // El conector tiene su propio límite, contado por licencia.
  app.use('/mcp', mcpRouter);

  app.use(globalLimiter);
  app.use(env.API_PREFIX, routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
