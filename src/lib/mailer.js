'use strict';

const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../config/logger');

/**
 * Transporte SMTP (Brevo). Sin host o sin contraseña se usa el transporte JSON:
 * el correo no sale a la red y el código queda visible en el log, que es lo que
 * hace falta para probar en desarrollo.
 */
const transporter = env.smtpEnabled
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // En el 587 se empieza en claro y se sube a TLS con STARTTLS; `secure`
      // solo va en true para el 465, que nace ya cifrado.
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
  : nodemailer.createTransport({ jsonTransport: true });

async function sendMail({ to, subject, html, text }) {
  const info = await transporter.sendMail({
    from: env.MAIL_FROM,
    // A dónde va la respuesta si el tesista le da a «Responder».
    //
    // Existe para poder separar las dos cosas: el remitente tiene que ser una
    // dirección del dominio propio —es lo que firma Brevo y lo que mira el
    // filtro antispam—, pero las respuestas conviene leerlas en el buzón de
    // siempre. Sin esto habría que elegir entre entregar bien o enterarse de
    // las respuestas.
    ...(env.MAIL_REPLY_TO ? { replyTo: env.MAIL_REPLY_TO } : {}),
    to,
    subject,
    html,
    text,
  });

  if (!env.smtpEnabled) {
    logger.info({ to, subject, text }, 'Correo simulado (SMTP sin configurar)');
  } else {
    logger.info({ to, subject, messageId: info.messageId }, 'Correo enviado');
  }

  return info;
}

/**
 * Comprueba las credenciales SMTP contra el servidor. Se llama al arrancar para
 * enterarse de una contraseña mal puesta ahí y no en el primer registro.
 */
async function verifyTransport() {
  if (!env.smtpEnabled) {
    logger.warn('SMTP sin configurar: los correos se escribirán en el log');
    return false;
  }

  try {
    await transporter.verify();
    logger.info({ host: env.SMTP_HOST, from: env.MAIL_FROM }, 'SMTP verificado');
    return true;
  } catch (error) {
    // No se aborta el arranque: la API sigue siendo útil aunque el correo falle.
    logger.error({ err: error, host: env.SMTP_HOST }, 'No se pudo verificar el SMTP');
    return false;
  }
}

module.exports = { sendMail, verifyTransport, transporter };
