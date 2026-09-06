'use strict';

const path = require('node:path');
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

  // DOS saltos, no uno: navegador → Netlify → Caddy → aquí.
  //
  // Con 1, Express se quedaba con la IP del borde de Netlify y esa pasaba a ser
  // la clave del limitador de peticiones. Resultado: TODOS los visitantes de la
  // web compartían un mismo cubo, y como el límite de autenticación son diez
  // intentos por cuarto de hora, el undécimo que intentara registrarse recibía
  // un 429 aunque fuese el primero en probarlo.
  //
  // CONTRAPARTIDA, y conviene tenerla presente: confiar en dos saltos significa
  // que una petición dirigida al backend SIN pasar por Netlify puede fabricar
  // su propia cabecera X-Forwarded-For y elegir con qué clave se la cuenta, o
  // sea, esquivar el límite. Se acepta porque la alternativa era dejar la web
  // sin registro ni acceso en cuanto hubiera dos personas a la vez, y porque
  // quien quiera saltarse un límite por IP puede rotar IPs igualmente.
  app.set('trust proxy', 2);
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

  // La guía de instalación, servida desde aquí.
  //
  // Va detrás del límite global a propósito: es un PDF de casi un mega y sin
  // freno cualquiera podría pedirlo en bucle. Y se declara UN archivo concreto
  // en vez de exponer la carpeta con `express.static`, porque una carpeta
  // servida entera es una invitación a que mañana alguien deje ahí algo que no
  // debía ser público.
  app.get('/guias/guia-instalacion.pdf', (req, res, next) => {
    res.sendFile(path.join(env.GUIAS_DIR, 'guia-instalacion.pdf'), (error) => {
      // Si el archivo no está, que caiga en el 404 normal y quede en el log:
      // el correo de compra enlaza aquí, así que un fallo silencioso sería
      // exactamente lo que no queremos.
      if (error) next(error.status === 404 ? undefined : error);
    });
  });

  app.use(env.API_PREFIX, routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
