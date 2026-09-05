'use strict';

const { OAuth2Client } = require('google-auth-library');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { UnauthorizedError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');

/**
 * Verificación del token de Google.
 *
 * El navegador recibe de Google un JWT firmado y nos lo manda. Aquí se
 * comprueba de verdad: la firma contra las claves públicas de Google, que el
 * `aud` sea NUESTRO cliente y que no haya caducado. Sin esas tres cosas
 * cualquiera podría fabricarse un token y entrar como quien quisiera.
 *
 * `OAuth2Client` se encarga de descargar y cachear las claves, y de la rotación
 * cuando Google las cambia. Hacer eso a mano con `jsonwebtoken` es donde se
 * cuelan los fallos: aceptar `alg: none`, no revalidar el `aud`, cachear una
 * clave retirada.
 */

const cliente = env.googleClientIds.length > 0 ? new OAuth2Client(env.googleClientIds[0]) : null;

function rechazar(motivo) {
  return new UnauthorizedError(motivo, ERROR_CODES.INVALID_CREDENTIALS);
}

const googleVerifier = {
  habilitado: () => Boolean(cliente),

  /**
   * Devuelve la identidad que afirma Google, ya comprobada.
   *
   * Lanza si el token no vale. Nunca devuelve datos «a medias»: quien llama
   * puede confiar en que el correo está verificado por Google, que es lo que
   * permite enlazar con una cuenta existente sin pedir contraseña.
   */
  async verificar(idToken) {
    if (!cliente) {
      throw rechazar('El acceso con Google no está configurado en el servidor.');
    }

    let payload;
    try {
      const ticket = await cliente.verifyIdToken({
        idToken,
        // Cualquiera de nuestros clientes vale; ninguno ajeno.
        audience: env.googleClientIds,
      });
      payload = ticket.getPayload();
    } catch (error) {
      logger.warn({ err: error }, 'Token de Google rechazado');
      throw rechazar('No pudimos validar tu cuenta de Google. Vuelve a intentarlo.');
    }

    if (!payload?.sub || !payload.email) {
      throw rechazar('Google no devolvió un correo para esta cuenta.');
    }

    // ESTE es el control que sostiene todo lo demás. Sin él, alguien podría
    // crear una cuenta de Google con el correo de otra persona sin demostrar
    // que lo controla, y al enlazar se quedaría con su cuenta de aquí.
    if (payload.email_verified !== true) {
      throw rechazar('Tu correo de Google no está verificado. Verifícalo y vuelve a entrar.');
    }

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      // Google no siempre manda el nombre partido; se completa con lo que haya.
      firstName: payload.given_name?.trim() || payload.name?.trim()?.split(' ')[0] || 'Tesista',
      lastName:
        payload.family_name?.trim() ||
        payload.name?.trim()?.split(' ').slice(1).join(' ') ||
        '—',
    };
  },
};

module.exports = googleVerifier;
