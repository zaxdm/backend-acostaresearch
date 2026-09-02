'use strict';

const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../config/logger');

// Sin SMTP configurado (desarrollo) usamos el transporte JSON: el correo no sale
// a la red y el enlace queda visible en el log, que es lo que se necesita para probar.
const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

async function sendMail({ to, subject, html, text }) {
  const info = await transporter.sendMail({ from: env.MAIL_FROM, to, subject, html, text });

  if (!env.SMTP_HOST) {
    logger.info({ to, subject, text }, 'Correo simulado (sin SMTP configurado)');
  } else {
    logger.info({ to, subject, messageId: info.messageId }, 'Correo enviado');
  }

  return info;
}

module.exports = { sendMail, transporter };
