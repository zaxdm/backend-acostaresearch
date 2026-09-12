'use strict';

/**
 * El enlace para descargar el Word desde la conversación con Claude.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * El Word se descarga desde el panel, con la sesión del tesista. Pero quien
 * termina un capítulo está hablando con Claude, no en el panel, y lo que pasaba
 * es que Claude le armaba el Word por su cuenta: sin la norma del proyecto, sin
 * la bibliografía que sale de las fichas y sin los campos de Zotero. Con esto,
 * Claude le da un enlace al Word de verdad y no tiene motivo para fabricarlo.
 *
 * CÓMO SE PROTEGE
 * ---------------
 * Es un JWT firmado con el mismo secreto que la sesión pero con OTRA audiencia
 * y otro tipo: un enlace de descarga no vale como sesión, y una sesión no vale
 * como enlace. Lleva dentro de quién es y qué proyecto, así que no se puede
 * cambiar de tesis tocando la dirección. Caduca a la media hora: lo justo para
 * pulsarlo, y poco para que sirva de algo si se queda en un historial.
 */

const jwt = require('jsonwebtoken');

const env = require('../../config/env');

const TIPO = 'descarga-word';
const DURACION = '30m';
const MINUTOS = 30;

const audiencia = () => `${env.JWT_AUDIENCE}:${TIPO}`;

function firmar({ userId, productCode }) {
  return jwt.sign({ typ: TIPO, pc: productCode }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: DURACION,
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });
}

/** De quién y de qué proyecto es el enlace. Lanza si no es válido o ha caducado. */
function verificar(token) {
  const datos = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: env.JWT_ISSUER,
    audience: audiencia(),
  });

  if (datos.typ !== TIPO || !datos.sub || !datos.pc) {
    throw new Error('No es un enlace de descarga.');
  }

  return { userId: datos.sub, productCode: datos.pc };
}

/**
 * La dirección pública de la API.
 *
 * Sale de la del conector —«https://api.acostaresearch.com/mcp»— porque es la
 * única dirección pública de la API que ya está configurada y comprobada: si
 * esa no fuera correcta, Claude no podría ni conectarse.
 */
function baseDeLaApi() {
  return String(env.MCP_PUBLIC_URL).replace(/\/mcp\/?$/, '') + env.API_PREFIX;
}

function enlace({ userId, productCode }) {
  const token = firmar({ userId, productCode });
  return { url: `${baseDeLaApi()}/proyectos/descarga/${token}`, minutos: MINUTOS };
}

module.exports = { firmar, verificar, enlace, baseDeLaApi, MINUTOS };
