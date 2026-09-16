'use strict';

/**
 * El enlace para subir el documento del tesista desde la conversación.
 *
 * Quien pide «humaniza mi documento» o «cita mi documento» está hablando con
 * Claude, no en su perfil. Si no subió ninguno, o el que hay es una versión
 * vieja, Claude le pregunta y le da este enlace; lo sube y vuelve a la
 * conversación. Lo que se hace con el archivo es lo mismo que en la subida del
 * perfil (`documento.service.subir`): conserva las citas y lo humanizado de los
 * párrafos que siguen igual.
 *
 * Mismo esquema que `project.subida-formato`: un JWT con su propia audiencia y
 * su propio tipo, así que no vale como sesión ni como otro enlace. Lleva de quién
 * es y de qué método, y vale media hora.
 */

const jwt = require('jsonwebtoken');

const env = require('../../config/env');

const TIPO = 'subir-documento';
const MINUTOS = 30;

const audiencia = () => `${env.JWT_AUDIENCE}:${TIPO}`;

/** La página de la web donde se sube el documento. */
function enlace({ userId, productCode }) {
  const token = jwt.sign({ typ: TIPO, pc: productCode }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: `${MINUTOS}m`,
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });
  const web = String(env.APP_URL).replace(/\/$/, '');
  return { url: `${web}/subir-documento/${token}`, minutos: MINUTOS };
}

/** De quién y de qué método es el enlace. Lanza si no es válido o ha caducado. */
function verificar(token) {
  const datos = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });

  if (datos.typ !== TIPO || !datos.sub || !datos.pc) {
    throw new Error('No es un enlace para subir el documento.');
  }

  return { userId: datos.sub, productCode: datos.pc, caduca: new Date(datos.exp * 1000) };
}

module.exports = { enlace, verificar, MINUTOS };
