'use strict';

const env = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./lib/prisma');
const createApp = require('./app');
const { verifyTransport } = require('./lib/mailer');

async function bootstrap() {
  // Fallar aquí y no en la primera petición si la BD no responde.
  await prisma.$connect();
  logger.info('Conexión con la base de datos establecida');

  // No bloquea el arranque: solo deja constancia en el log de si el correo saldrá.
  await verifyTransport();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API escuchando en http://localhost:${env.PORT}${env.API_PREFIX} [${env.NODE_ENV}]`);
  });

  // Apagado ordenado: se dejan terminar las peticiones en curso.
  const shutdown = (signal) => async () => {
    logger.info(`${signal} recibido, cerrando servidor…`);
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('Servidor cerrado correctamente');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Cierre forzado tras agotar el tiempo de espera');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Promesa rechazada sin manejar');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Excepción no capturada');
    process.exit(1);
  });
}

bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'No se pudo iniciar el servidor');
  process.exit(1);
});
