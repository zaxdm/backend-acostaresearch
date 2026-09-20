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
const enlacesCortosRouter = require('./modules/enlaces/enlaceCorto.routes');
const { globalLimiter } = require('./middlewares/rateLimit');
const { ocultarSecretosEnUrl, ocultarConsulta, ocultarParams } = require('./shared/utils/ocultar');
const { ForbiddenError } = require('./shared/errors/AppError');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

function createApp() {
  const app = express();

  // Solo Caddy, que está en esta misma máquina.
  //
  // Caddy no se fía del X-Forwarded-For que le llega y lo reemplaza por la IP
  // que ve: comprobado contra producción el 15-sep-2026, dos cabeceras falsas
  // cayeron en el mismo cubo. Confiar en él basta para que nadie elija su IP, y
  // confiar en más saltos no añadía nada. (Antes eran dos, de cuando delante
  // estaba Netlify.)
  //
  // Para la web, la IP que ve Caddy es la de Cloudflare, compartida por muchos
  // visitantes. La del visitante la manda el Worker aparte, firmada con un
  // secreto: ver `shared/utils/ipCliente`, que es lo que usan los límites.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // Sin Origin (curl, health checks del balanceador) se permite.
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        // Un 403 y no un Error suelto: aquel llegaba al manejador como fallo del
        // servidor y dejaba un error grave en el registro cada vez que alguien
        // abría la web en local contra la API de producción.
        return callback(new ForbiddenError(`Origen no permitido por CORS: ${origin}`));
      },
      credentials: true, // imprescindible para la cookie del refresh token
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      // La URL del conector ES la licencia, y el `redact` de pino no mira dentro
      // de una cadena. Sin esto, cada llamada dejaba una licencia usable en el
      // journal. Ver `shared/utils/ocultar`.
      serializers: {
        req: (req) => ({
          ...req,
          url: ocultarSecretosEnUrl(req.url),
          query: ocultarConsulta(req.query),
          params: ocultarParams(req.params),
        }),
      },
    }),
  );

  // El conector MCP va ANTES del límite global a propósito: ese límite cuenta
  // por IP, y todas las llamadas de Claude llegan desde la misma dirección de
  // Anthropic. Aplicarlo aquí metería a todos los compradores en el mismo cubo.
  // El conector tiene su propio límite, contado por licencia.
  app.use('/mcp', mcpRouter);

  // Claude pregunta por OAuth antes de conectar (`/.well-known/oauth-…`). El
  // conector no usa OAuth —la licencia va en la URL—, así que la respuesta es
  // «no existe»; pero dada por el 404 general dejaba un aviso en el registro por
  // cada conexión de cada tesista. Se contesta aquí, sin anotarlo como error.
  app.use('/.well-known', (_req, res) =>
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No existe.' } }),
  );

  app.use(globalLimiter);

  // Los enlaces cortos del conector, `/s/<código>`.
  //
  // Detrás del límite global: son ocho caracteres y sin freno se podrían
  // sondear a ciegas. Y sin el prefijo de la API, porque el asistente tiene que
  // reproducir esta dirección en la conversación y cada carácter cuenta.
  app.use('/s', enlacesCortosRouter);

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
