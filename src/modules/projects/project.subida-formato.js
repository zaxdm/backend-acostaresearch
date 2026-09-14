'use strict';

/**
 * El enlace para subir el formato de la universidad desde la conversación.
 *
 * POR QUÉ ASÍ
 * -----------
 * El recuadro «Subir formato» del perfil se quitó: quien escribe su tesis está
 * hablando con Claude, no en el perfil, y descubría el recuadro cuando ya había
 * bajado su Word en Times New Roman. Ahora lo pregunta Claude —«¿tu universidad
 * te dio un formato?»— y, si lo hay, le da este enlace, igual que el de subir la
 * matriz de R (ver `r.enlaces`).
 *
 * Mismo esquema que el enlace del Word: un JWT firmado con el secreto de la
 * sesión, con su propia audiencia y su propio tipo, así que no vale como sesión
 * ni como ningún otro enlace. Lleva dentro de quién es y qué método: tocar la
 * dirección no cambia de tesis. Vale media hora y se puede volver a subir dentro
 * de ese plazo, porque lo normal es equivocarse de archivo la primera vez.
 */

const jwt = require('jsonwebtoken');

const env = require('../../config/env');

const TIPO = 'subir-formato';
const MINUTOS = 30;

const audiencia = () => `${env.JWT_AUDIENCE}:${TIPO}`;

/** La página de la web donde se sube el formato. */
function enlace({ userId, productCode }) {
  const token = jwt.sign({ typ: TIPO, pc: productCode }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: `${MINUTOS}m`,
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });
  const web = String(env.APP_URL).replace(/\/$/, '');
  return { url: `${web}/subir-formato/${token}`, minutos: MINUTOS };
}

/** De quién y de qué método es el enlace. Lanza si no es válido o ha caducado. */
function verificar(token) {
  const datos = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });

  if (datos.typ !== TIPO || !datos.sub || !datos.pc) {
    throw new Error('No es un enlace para subir el formato.');
  }

  return { userId: datos.sub, productCode: datos.pc, caduca: new Date(datos.exp * 1000) };
}

module.exports = { enlace, verificar, MINUTOS };
