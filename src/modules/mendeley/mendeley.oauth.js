'use strict';

const crypto = require('node:crypto');

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');

/**
 * El OAuth 2 de Mendeley: «authorization code», tal como lo documenta
 * dev.mendeley.com/reference/topics/authorization_auth_code.html.
 *
 * LO QUE DICE SU MANUAL, Y ESTE ARCHIVO SIGUE AL PIE DE LA LETRA
 * -------------------------------------------------------------
 *   · Autorizar: `https://api.mendeley.com/oauth/authorize`, con
 *     `response_type=code`, `scope=all` —el único que existe: no hay uno de
 *     solo lectura— y un `state`.
 *   · Canjear y refrescar: POST a `https://api.mendeley.com/oauth/token`, con
 *     el cliente en `Authorization: Basic` y `redirect_uri` en el cuerpo.
 *   · El token de acceso vive una hora (`expires_in: 3600`) y viene con uno de
 *     refresco.
 *
 * NO HAY PKCE. Mendeley no lo documenta, y mandar un `code_challenge` que el
 * servidor ignora daría una seguridad que no existe. Lo que ata la vuelta al
 * navegador que empezó es el `state`, guardado en la base Y en una cookie
 * httpOnly de ese navegador: ver el controlador.
 *
 * SOBRE `scope=all`, QUE HAY QUE DECIRLE AL TESISTA
 * ------------------------------------------------
 * Mendeley no ofrece un permiso de solo lectura: el token puede escribir en su
 * biblioteca. Este servidor solo hace GET —no hay en este módulo una sola
 * petición que escriba— pero tenerlo sin quererlo es un riesgo que se asume,
 * no que se evita. La pantalla de conectar lo dice.
 */

const AUTORIZAR = 'https://api.mendeley.com/oauth/authorize';
const TOKEN = 'https://api.mendeley.com/oauth/token';

function autorizacionDeCliente() {
  const par = `${env.MENDELEY_CLIENT_ID}:${env.MENDELEY_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(par).toString('base64')}`;
}

/** A dónde devuelve Mendeley al tesista. Pasa por el proxy de la web. */
function redireccion() {
  return env.MENDELEY_REDIRECT_URI || `${env.APP_URL}/api/v1/mi-mendeley/vuelta`;
}

/** El `state` y la dirección a la que mandarle. */
function empezar() {
  const state = crypto.randomBytes(32).toString('base64url');

  const url = new URL(AUTORIZAR);
  url.searchParams.set('client_id', env.MENDELEY_CLIENT_ID);
  url.searchParams.set('redirect_uri', redireccion());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'all');
  url.searchParams.set('state', state);

  return { state, url: url.toString() };
}

/**
 * Pide tokens: el canje del código o el refresco.
 *
 * Del cuerpo de la respuesta no se registra nada más que el código de error:
 * un token en el log es un token en cada respaldo.
 */
async function pedirTokens(cuerpo, queEs) {
  let respuesta;
  try {
    respuesta = await fetch(TOKEN, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: autorizacionDeCliente(),
      },
      body: new URLSearchParams(cuerpo).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (fallo) {
    logger.error({ err: fallo, queEs }, 'Mendeley: el canje de tokens no llegó a completarse');
    throw new AppError('Mendeley no contestó a tiempo. Vuelve a intentarlo.', {
      statusCode: 504,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });
  }

  const datos = await respuesta.json().catch(() => null);

  if (!respuesta.ok || !datos?.access_token) {
    logger.error(
      { estado: respuesta.status, error: datos?.error ?? null, queEs },
      'Mendeley: rechazó el canje de tokens',
    );
    const fallo = new AppError('Mendeley no completó la autorización. Vuelve a conectar tu cuenta.', {
      statusCode: 502,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
    });
    // Un refresco RECHAZADO no se arregla reintentando: el tesista retiró el
    // permiso o el de refresco caducó. Uno que no llegó a salir, sí. Se marca en
    // la instancia porque `AppError` descarta las opciones que no conoce.
    fallo.revocada = true;
    throw fallo;
  }

  return {
    accessToken: datos.access_token,
    refreshToken: datos.refresh_token ?? null,
    /** Segundos de vida. Sin el dato, la hora que documenta Mendeley. */
    expiraEn: Number(datos.expires_in) > 0 ? Number(datos.expires_in) : 3600,
  };
}

const canjear = (codigo) =>
  pedirTokens(
    { grant_type: 'authorization_code', code: codigo, redirect_uri: redireccion() },
    'canje',
  );

const refrescar = (refreshToken) =>
  pedirTokens(
    { grant_type: 'refresh_token', refresh_token: refreshToken, redirect_uri: redireccion() },
    'refresco',
  );

module.exports = { empezar, canjear, refrescar, redireccion, AUTORIZAR, TOKEN };
