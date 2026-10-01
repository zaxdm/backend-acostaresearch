'use strict';

const env = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./lib/prisma');
const createApp = require('./app');
const { verifyTransport } = require('./lib/mailer');
const { avisarAlProgramador } = require('./lib/notify');
const comprobarBase = require('./lib/comprobarBase');
const { INTERVALO_MS, crearVigia } = require('./lib/vigiaBase');
const ventasService = require('./modules/ventas/ventas.service');
const paymentService = require('./modules/payments/payment.service');
const avisosService = require('./modules/avisos/avisos.service');

/** Cada cuánto se mira si toca la pasada diaria de correos de avance. */
const AVISOS_MS = 60 * 60 * 1000;
const whatsappService = require('./modules/whatsapp/whatsapp.service');

/** Cada cuánto se mira si terminó un mes de ventas que haya que cerrar. */
const CIERRE_DE_MES_MS = 3 * 60 * 60 * 1000;

/** Cada cuánto se cierran las órdenes de pasarela abandonadas. */
const ORDENES_ABANDONADAS_MS = 30 * 60 * 1000;

/** Cada cuánto se borran las conversaciones de WhatsApp fuera de plazo. */
const PURGA_WHATSAPP_MS = 24 * 60 * 60 * 1000;

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

  // El vigilante de la base: pregunta cada medio minuto aunque no haya nadie en
  // la web, y avisa al móvil si deja de contestar. El `catch` no sobra: una
  // promesa rechazada sin manejar tumba el proceso, y ningún aviso vale eso.
  const vigilar = crearVigia({ comprobar: comprobarBase, avisar: avisarAlProgramador });
  const vigia = setInterval(() => {
    vigilar().catch((error) => logger.error({ err: error }, 'El vigilante de la base falló'));
  }, INTERVALO_MS);
  vigia.unref();

  // Los correos según el avance del tesista (y los días de referidos que
  // esperaban). Se mira cada hora; la pasada sale una vez al día, a partir de
  // las 9 de Lima. Ver `modules/avisos`.
  const estadoAvisos = { ultimoDia: null };
  const pasarAvisos = () =>
    avisosService
      .pasadaProgramada(estadoAvisos)
      .catch((error) => logger.error({ err: error }, 'La pasada de correos de avance falló'));
  const avisosDeAvance = setInterval(pasarAvisos, AVISOS_MS);
  avisosDeAvance.unref();
  setTimeout(pasarAvisos, 5 * 60_000).unref();

  // El cierre de ventas del mes: en cuanto termina un mes (hora de Lima), su
  // PDF queda guardado. Mirar cada tres horas basta; el panel también cierra
  // lo pendiente al abrir «Ventas mensuales».
  const cerrarMeses = () =>
    ventasService
      .cerrarPendientes()
      .catch((error) => logger.error({ err: error }, 'No se pudo cerrar el mes de ventas'));
  const cierreDeMes = setInterval(cerrarMeses, CIERRE_DE_MES_MS);
  cierreDeMes.unref();
  setTimeout(cerrarMeses, 60_000).unref();

  // Las órdenes de PayPal/Culqi que nadie terminó (ventana cerrada en el
  // móvil, tarjeta rechazada dentro de PayPal) se cierran solas. La primera
  // pasada, al minuto de arrancar, limpia también las que ya había.
  const cerrarAbandonadas = () =>
    paymentService
      .cerrarAbandonadas()
      .catch((error) => logger.error({ err: error }, 'No se cerraron las órdenes abandonadas'));
  const ordenesAbandonadas = setInterval(cerrarAbandonadas, ORDENES_ABANDONADAS_MS);
  ordenesAbandonadas.unref();
  setTimeout(cerrarAbandonadas, 60_000).unref();

  // Las conversaciones de WhatsApp se guardan WHATSAPP_RETENCION_DIAS y se
  // borran solas. Una vez al día basta; la primera, a los dos minutos.
  const purgarWhatsapp = () =>
    whatsappService
      .purgar()
      .catch((error) => logger.error({ err: error }, 'No se purgaron las conversaciones de WhatsApp'));
  const purgaWhatsapp = setInterval(purgarWhatsapp, PURGA_WHATSAPP_MS);
  purgaWhatsapp.unref();
  setTimeout(purgarWhatsapp, 120_000).unref();

  // Apagado ordenado: se dejan terminar las peticiones en curso.
  const shutdown = (signal) => async () => {
    logger.info(`${signal} recibido, cerrando servidor…`);
    clearInterval(vigia);
    clearInterval(avisosDeAvance);
    clearInterval(cierreDeMes);
    clearInterval(ordenesAbandonadas);
    clearInterval(purgaWhatsapp);
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
