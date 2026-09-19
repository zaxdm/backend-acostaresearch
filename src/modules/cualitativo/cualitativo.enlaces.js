'use strict';

/**
 * El enlace para subir las entrevistas desde la conversación.
 *
 * Mismo esquema que `project.subida-material`: un JWT con su propia audiencia y
 * su propio tipo, así que no vale como sesión ni como ningún otro enlace. Lleva
 * de quién es y de qué método, y vale media hora.
 */

const jwt = require('jsonwebtoken');

const env = require('../../config/env');

const TIPO = 'subir-entrevistas';
const MINUTOS = 30;

const audiencia = () => `${env.JWT_AUDIENCE}:${TIPO}`;

/** La página de la web donde se suben las entrevistas. */
function enlace({ userId, productCode }) {
  const token = jwt.sign({ typ: TIPO, pc: productCode }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: `${MINUTOS}m`,
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });
  const web = String(env.APP_URL).replace(/\/$/, '');
  return { url: `${web}/subir-entrevistas/${token}`, minutos: MINUTOS };
}

/** De quién y de qué método es el enlace. Lanza si no es válido o ha caducado. */
function verificar(token) {
  const datos = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });

  if (datos.typ !== TIPO || !datos.sub || !datos.pc) {
    throw new Error('No es un enlace para subir entrevistas.');
  }

  return { userId: datos.sub, productCode: datos.pc, caduca: new Date(datos.exp * 1000) };
}

module.exports = { enlace, verificar, MINUTOS };
