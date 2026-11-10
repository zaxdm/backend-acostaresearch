'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { AppError } = require('../../shared/errors/AppError');

/**
 * «Abrir Epicuro.ai» desde el panel (11-nov-2026): un pase firmado de un solo
 * uso que Epicuro cambia por una sesión de la misma persona. Lleva el método
 * que está mirando y la frase de su fase, para que Epicuro abra ese método con
 * la frase ya escrita y vincule la compra si aún no lo está.
 *
 * Se firma con la clave interna que ya comparten los dos (ACOSTAIA_CLAVE_INTERNA
 * aquí, BACKEND_CLAVE_INTERNA allá). Vale 2 minutos y Epicuro no acepta dos
 * veces el mismo `n`. Va en el «#» de la dirección: no queda en los registros
 * de ningún servidor.
 */

const VIGENCIA_MS = 2 * 60 * 1000;

function firmar(datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto.createHmac('sha256', env.ACOSTAIA_CLAVE_INTERNA).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

const epicuroEntrada = {
  firmar,

  async pase({ userId, productCode, frase }) {
    if (!env.ACOSTAIA_CLAVE_INTERNA) {
      throw new AppError('Epicuro.ai todavía no está conectado. Inténtalo más tarde.', { statusCode: 503 });
    }
    const usuario = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (!usuario) throw new AppError('No encontramos tu cuenta.', { statusCode: 404 });

    const token = firmar({
      email: usuario.email.toLowerCase(),
      nombre: usuario.firstName,
      apellido: usuario.lastName,
      ...(productCode && { productCode: String(productCode).slice(0, 60) }),
      ...(frase && { frase: String(frase).slice(0, 400) }),
      exp: Date.now() + VIGENCIA_MS,
      n: crypto.randomBytes(12).toString('base64url'),
    });
    return { url: `${env.EPICURO_WEB_URL.replace(/\/+$/, '')}/desde-acosta#t=${token}` };
  },
};

module.exports = epicuroEntrada;
