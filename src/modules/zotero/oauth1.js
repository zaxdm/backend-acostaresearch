'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');

/**
 * OAuth 1.0a contra Zotero, escrito a mano.
 *
 * POR QUÉ A MANO Y NO CON UNA LIBRERÍA
 * ------------------------------------
 * Son ochenta líneas y una firma HMAC-SHA1. Las librerías de OAuth 1 que quedan
 * llevan años sin tocarse —el mundo se fue a OAuth 2— y meter una dependencia
 * abandonada en el camino por el que entra una credencial ajena es peor negocio
 * que escribir la firma.
 *
 * POR QUÉ ZOTERO SIGUE EN OAUTH 1.0a
 * ----------------------------------
 * Porque es lo que hay. No hay OAuth 2 en su API, así que no es una elección.
 *
 * LO QUE DEVUELVE ZOTERO Y NO SE PARECE AL ESTÁNDAR
 * -------------------------------------------------
 * En OAuth 1.0a normal, el tercer paso devuelve un token de acceso con el que
 * se firma cada petición posterior. Zotero no: devuelve directamente UNA CLAVE
 * DE API de las de siempre, la misma que se crearía a mano en
 * zotero.org/settings/keys, y a partir de ahí no se vuelve a firmar nada — se
 * manda la cabecera `Zotero-API-Key` y ya está. La clave viaja en el campo
 * `oauth_token_secret`, que es el sitio menos evidente posible.
 *
 * Consecuencia práctica: esta firma solo se usa tres veces, al conectar. La
 * sincronización de todas las noches no pasa por aquí.
 */

const PEDIR_TOKEN = 'https://www.zotero.org/oauth/request';
const AUTORIZAR = 'https://www.zotero.org/oauth/authorize';
const CANJEAR = 'https://www.zotero.org/oauth/access';

/**
 * El escapado de OAuth, que NO es el de `encodeURIComponent`.
 *
 * `!`, `'`, `(`, `)` y `*` quedan sin escapar en el de JavaScript y OAuth exige
 * escaparlos. Un solo carácter de diferencia cambia la cadena base y la firma
 * sale mal, y el error que devuelve el servidor es un 401 pelado que no dice
 * cuál de las treinta cosas posibles falló.
 */
function escapar(valor) {
  return encodeURIComponent(String(valor)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * La firma HMAC-SHA1 de una petición.
 *
 * La cadena base es MÉTODO&url&parámetros, cada trozo escapado, y los
 * parámetros ordenados alfabéticamente. El orden no es estética: el servidor
 * rehace esta misma cadena por su cuenta y compara, así que cualquier
 * diferencia —un parámetro fuera de sitio, un espacio como «+» en vez de
 * «%20»— produce un 401 sin explicación.
 */
function firmar({ metodo, url, params, secretoToken = '' }) {
  const ordenados = Object.keys(params)
    .sort()
    .map((clave) => `${escapar(clave)}=${escapar(params[clave])}`)
    .join('&');

  const base = [metodo.toUpperCase(), escapar(url), escapar(ordenados)].join('&');
  const llave = `${escapar(env.ZOTERO_OAUTH_CLIENT_SECRET)}&${escapar(secretoToken)}`;

  return crypto.createHmac('sha1', llave).update(base).digest('base64');
}

function comunes() {
  return {
    oauth_consumer_key: env.ZOTERO_OAUTH_CLIENT_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
}

/** Zotero contesta en `application/x-www-form-urlencoded`, no en JSON. */
async function llamar(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const cuerpo = await res.text();
  if (!res.ok) {
    throw new Error(`Zotero respondió ${res.status} al negociar el acceso: ${cuerpo.slice(0, 200)}`);
  }

  return Object.fromEntries(new URLSearchParams(cuerpo));
}

/**
 * Paso 1: pedir un token temporal.
 *
 * El `oauth_callback` viaja FIRMADO —va dentro de los parámetros de la firma—,
 * así que no se puede cambiar por el camino: quien intercepte el enlace no
 * puede desviar la vuelta a otro sitio.
 */
async function pedirTokenTemporal(urlDeVuelta) {
  const params = { ...comunes(), oauth_callback: urlDeVuelta };
  params.oauth_signature = firmar({ metodo: 'POST', url: PEDIR_TOKEN, params });

  const respuesta = await llamar(PEDIR_TOKEN, params);
  if (!respuesta.oauth_token || !respuesta.oauth_token_secret) {
    throw new Error('Zotero no devolvió el token temporal.');
  }

  return { token: respuesta.oauth_token, secreto: respuesta.oauth_token_secret };
}

/**
 * Paso 2: a dónde se manda al tesista.
 *
 * LOS PERMISOS SE PIDEN AQUÍ, Y SE PIDEN AL MÍNIMO.
 *
 * `write_access=0` es lo importante: sin él, la clave que emita Zotero podría
 * modificar y borrar en la biblioteca del tesista, y esa biblioteca es el
 * trabajo de sus últimos meses. Nosotros solo leemos, así que pedir escritura
 * sería pedir un permiso que no se usa y que un día se usa por error.
 *
 * `notes_access=0`: sus notas son suyas y no hacen falta para citar. La ficha
 * —autores, año, revista, DOI— es todo lo que necesita la bibliografía.
 *
 * `all_groups=none`: sus grupos son de otra gente. Un grupo de investigación
 * compartido puede tener dentro material que no es suyo para dar.
 */
function urlDeAutorizacion(token) {
  const url = new URL(AUTORIZAR);
  url.searchParams.set('oauth_token', token);
  url.searchParams.set('name', 'Acosta | IA & Research');
  url.searchParams.set('library_access', '1');
  url.searchParams.set('notes_access', '0');
  url.searchParams.set('write_access', '0');
  url.searchParams.set('all_groups', 'none');
  return url.toString();
}

/**
 * Paso 3: canjear el token autorizado por la clave de API.
 *
 * Aquí es donde Zotero se sale del estándar: `oauth_token_secret` no es un
 * secreto de token, es LA CLAVE DE API. Y manda además el `userID`, que es lo
 * que forma la ruta de su biblioteca — sin él habría que preguntárselo al
 * tesista, que no sabe que tiene un número.
 */
async function canjear({ token, secreto, verificador }) {
  const params = { ...comunes(), oauth_token: token, oauth_verifier: verificador };
  params.oauth_signature = firmar({
    metodo: 'POST',
    url: CANJEAR,
    params,
    secretoToken: secreto,
  });

  const respuesta = await llamar(CANJEAR, params);

  const apiKey = respuesta.oauth_token_secret || respuesta.oauth_token;
  if (!apiKey || !respuesta.userID) {
    throw new Error('Zotero no devolvió la clave de acceso.');
  }

  return {
    apiKey,
    zoteroUserId: String(respuesta.userID),
    username: respuesta.username || null,
  };
}

module.exports = { pedirTokenTemporal, urlDeAutorizacion, canjear, escapar, firmar };
