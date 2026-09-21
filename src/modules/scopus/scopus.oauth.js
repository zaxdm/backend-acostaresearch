'use strict';

const crypto = require('node:crypto');

const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');

/**
 * El OAuth 2 de Elsevier, escrito contra el estándar y no contra su manual.
 *
 * POR QUÉ ESTE ARCHIVO NO NOMBRA NI UNA SOLA URL DE ELSEVIER
 * ---------------------------------------------------------
 * Porque Elsevier no las publica. Su documentación de autenticación dice, con
 * estas palabras, que ofrecen «an oauth implementation for developers wanting
 * to integrate ScienceDirect and/or Scopus content into client-side
 * applications requiring access to user level (rather than institutional)
 * content» — y ahí se acaba. No hay endpoint de autorización, ni de canje, ni
 * lista de scopes, ni forma de registrar un `client_id` desde el portal, que
 * solo emite API Keys. Se pide escribiendo a apisupport@elsevier.com.
 *
 * Adivinar esas URL y escribirlas aquí habría sido lo peor de las dos opciones:
 * el código parecería terminado, fallaría en producción con un 404 y el día que
 * Elsevier contestara nadie sabría que el valor bueno estaba enterrado en un
 * archivo fuente. Van en el `.env`. Con ellas rellenas, este archivo funciona
 * sin tocar una línea; sin ellas, `scopusOauthEnabled` es false y el botón
 * conecta por el otro camino.
 *
 * LO QUE SÍ ESTÁ DECIDIDO AQUÍ
 * ---------------------------
 * El flujo es «authorization code» con PKCE (RFC 7636) y `state`. Las dos cosas
 * hacen falta y ninguna depende de Elsevier:
 *
 *   · `state` ata la vuelta al navegador que empezó. Sin él, cualquiera puede
 *     mandarle a un tesista una dirección de autorización preparada y quedarse
 *     con su conexión.
 *   · PKCE hace que el código que vuelve por la barra de direcciones no sirva
 *     de nada sin el verificador, que nunca salió de este servidor. Un código
 *     de autorización viaja por la URL: acaba en el historial, en el registro
 *     del proxy y en la cabecera `Referer` de la página siguiente.
 */

/** El secreto de cliente va en `Authorization: Basic`, nunca en el cuerpo. */
function autorizacionDeCliente() {
  const par = `${env.ELSEVIER_CLIENT_ID}:${env.ELSEVIER_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(par).toString('base64')}`;
}

/**
 * A dónde devuelve Elsevier al tesista.
 *
 * Por defecto se arma sobre `APP_URL` y pasa por el proxy de la web, igual que
 * la de Zotero. Se puede fijar a mano porque Elsevier compara esta dirección
 * carácter por carácter con la que quede registrada de su lado, y esa la
 * decide él.
 */
function redireccion() {
  return env.ELSEVIER_REDIRECT_URI || `${env.APP_URL}/api/v1/mi-scopus/vuelta`;
}

/**
 * Arranca el intercambio: el par (state, verificador) y la dirección.
 *
 * Los dos son aleatorios de 32 bytes. El `state` se guarda como clave de la
 * fila y el verificador cifrado dentro de ella; lo que se manda a Elsevier es
 * el RETO, que es el hash del verificador y no permite deshacerlo.
 */
function empezar() {
  const state = crypto.randomBytes(32).toString('base64url');
  const verificador = crypto.randomBytes(32).toString('base64url');
  const reto = crypto.createHash('sha256').update(verificador).digest('base64url');

  const url = new URL(env.ELSEVIER_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.ELSEVIER_CLIENT_ID);
  url.searchParams.set('redirect_uri', redireccion());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', reto);
  url.searchParams.set('code_challenge_method', 'S256');
  if (env.ELSEVIER_SCOPE) url.searchParams.set('scope', env.ELSEVIER_SCOPE);

  return { state, verificador, url: url.toString() };
}

/**
 * Pide tokens. Sirve para el canje del código y para el refresco.
 *
 * Lo que se registra de la respuesta es el ESTADO y nada más. Un cuerpo de
 * token en el registro es un token en el registro, y de ahí pasa a cualquier
 * copia de seguridad y a cualquier informe de error que alguien pegue en un
 * chat.
 */
async function pedirTokens(cuerpo, queEs) {
  let respuesta;
  try {
    respuesta = await fetch(env.ELSEVIER_TOKEN_URL, {
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
    logger.error({ err: fallo, queEs }, 'Scopus: el canje de tokens no llegó a completarse');
    throw new AppError('Elsevier no contestó a tiempo. Vuelve a intentarlo.', {
      statusCode: 504,
      code: ERROR_CODES.EXTERNAL_UNAVAILABLE,
    });
  }

  const datos = await respuesta.json().catch(() => null);

  if (!respuesta.ok || !datos?.access_token) {
    logger.error(
      { estado: respuesta.status, error: datos?.error ?? null, queEs },
      'Scopus: Elsevier rechazó el canje de tokens',
    );
    const fallo = new AppError(
      'Elsevier no completó la autorización. Vuelve a conectar tu cuenta.',
      { statusCode: 502, code: ERROR_CODES.EXTERNAL_UNAVAILABLE },
    );
    // Se marca EN LA INSTANCIA y no como opción del constructor: `AppError`
    // solo se queda con `statusCode`, `code` y `details`, así que una opción
    // de más se perdería en silencio y el servicio nunca vería la diferencia.
    //
    // La lee para decidir si la conexión queda REVOCADA o solo CADUCADA: un
    // refresco que Elsevier RECHAZA no se arregla reintentando —retiró el
    // permiso—, y uno que no llegó a salir, sí.
    fallo.rechazadoPorElsevier = true;
    throw fallo;
  }

  return {
    accessToken: datos.access_token,
    refreshToken: datos.refresh_token ?? null,
    /** Segundos de vida. Sin el dato, se da por caducado en una hora. */
    expiraEn: Number(datos.expires_in) > 0 ? Number(datos.expires_in) : 3600,
    /**
     * Quién es, si Elsevier lo dice.
     *
     * No está garantizado y no se depende de ello: es para enseñárselo al
     * tesista y que reconozca qué cuenta conectó. La identidad con la que se
     * filtra en esta casa es siempre la de aquí.
     */
    scopusUserId: datos.user_id ?? datos.sub ?? null,
    scopusName: datos.name ?? datos.email ?? null,
  };
}

const canjear = ({ codigo, verificador }) =>
  pedirTokens(
    {
      grant_type: 'authorization_code',
      code: codigo,
      redirect_uri: redireccion(),
      client_id: env.ELSEVIER_CLIENT_ID,
      code_verifier: verificador,
    },
    'canje',
  );

const refrescar = (refreshToken) =>
  pedirTokens(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.ELSEVIER_CLIENT_ID,
    },
    'refresco',
  );

module.exports = { empezar, canjear, refrescar, redireccion };
