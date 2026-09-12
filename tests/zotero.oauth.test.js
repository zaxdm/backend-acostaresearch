'use strict';

/**
 * La firma de OAuth 1.0a contra Zotero.
 *
 * Esto se prueba porque su fallo es el peor de diagnosticar del proyecto: una
 * firma mal armada devuelve un 401 pelado, sin decir cuál de los treinta
 * detalles falló, y los treinta parecen bien a simple vista.
 *
 * Se comprueba lo que de verdad se rompe:
 *
 *   · El escapado de OAuth NO es `encodeURIComponent`. Cinco caracteres se
 *     escapan aquí y allí no. Un solo carácter de diferencia cambia la cadena
 *     base y tira la firma.
 *   · Los parámetros van ordenados. El servidor rehace la misma cadena y
 *     compara: si aquí salen en otro orden, no hay nada que hacer.
 *   · Zotero devuelve LA CLAVE DE API en `oauth_token_secret`, que es el sitio
 *     menos evidente posible. Si algún día eso cambia, esta prueba lo dice.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const rutaEnv = require.resolve('../src/config/env');

const env = {
  ZOTERO_OAUTH_CLIENT_KEY: 'la-clave-de-la-aplicacion',
  ZOTERO_OAUTH_CLIENT_SECRET: 'el-secreto-de-la-aplicacion',
};
require.cache[rutaEnv] = { id: rutaEnv, filename: rutaEnv, loaded: true, exports: env };

const oauth = require('../src/modules/zotero/oauth1');

test('el escapado es el de OAuth y no el de JavaScript', () => {
  // Estos cinco los deja pasar `encodeURIComponent` y OAuth exige escaparlos.
  assert.equal(oauth.escapar("!'()*"), '%21%27%28%29%2A');
  // Y un espacio es %20, nunca «+».
  assert.equal(oauth.escapar('dos palabras'), 'dos%20palabras');
  // Lo que no se toca: la tilde, el guion, el punto y el guion bajo.
  assert.equal(oauth.escapar("~-._"), '~-._');
});

test('la firma se calcula sobre la cadena base del estándar', () => {
  const url = 'https://www.zotero.org/oauth/request';
  const params = {
    // A propósito en desorden: la firma tiene que ordenarlos ella.
    oauth_version: '1.0',
    oauth_consumer_key: 'la-clave-de-la-aplicacion',
    oauth_timestamp: '1757600000',
    oauth_callback: 'https://acostaresearch.com/api/v1/mi-zotero/vuelta',
    oauth_signature_method: 'HMAC-SHA1',
    oauth_nonce: 'abc123',
  };

  // Escrita a mano, en orden alfabético, que es lo que dice el estándar.
  const listaEsperada =
    'oauth_callback=https%3A%2F%2Facostaresearch.com%2Fapi%2Fv1%2Fmi-zotero%2Fvuelta' +
    '&oauth_consumer_key=la-clave-de-la-aplicacion' +
    '&oauth_nonce=abc123' +
    '&oauth_signature_method=HMAC-SHA1' +
    '&oauth_timestamp=1757600000' +
    '&oauth_version=1.0';

  const escapar = (t) => encodeURIComponent(t).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const baseEsperada = `POST&${escapar(url)}&${escapar(listaEsperada)}`;
  const llave = `${escapar(env.ZOTERO_OAUTH_CLIENT_SECRET)}&`;
  const esperada = crypto.createHmac('sha1', llave).update(baseEsperada).digest('base64');

  assert.equal(oauth.firmar({ metodo: 'POST', url, params }), esperada);
});

test('el secreto del token entra en la llave, no en los parámetros', () => {
  const comunes = { metodo: 'POST', url: 'https://www.zotero.org/oauth/access', params: { a: '1' } };

  const sinSecreto = oauth.firmar(comunes);
  const conSecreto = oauth.firmar({ ...comunes, secretoToken: 'el-secreto-temporal' });

  assert.notEqual(sinSecreto, conSecreto, 'el secreto del token tiene que cambiar la firma');
});

test('los permisos que se piden al autorizar son los mínimos', () => {
  const url = new URL(oauth.urlDeAutorizacion('token-temporal'));

  assert.equal(url.origin + url.pathname, 'https://www.zotero.org/oauth/authorize');
  assert.equal(url.searchParams.get('oauth_token'), 'token-temporal');
  assert.equal(url.searchParams.get('library_access'), '1', 'hay que poder leer su biblioteca');
  assert.equal(url.searchParams.get('write_access'), '0', 'NUNCA escritura sobre su Zotero');
  assert.equal(url.searchParams.get('notes_access'), '0', 'sus notas no hacen falta para citar');
  assert.equal(url.searchParams.get('all_groups'), 'none', 'sus grupos son de otra gente');
});

test('la clave de API se recoge de oauth_token_secret, que es donde la manda Zotero', async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      'oauth_token=P9xKzQ2mNv7bT4rH&oauth_token_secret=P9xKzQ2mNv7bT4rH&userID=8675309&username=tesista',
  });

  const acceso = await oauth.canjear({
    token: 'token-temporal',
    secreto: 'secreto-temporal',
    verificador: 'verificador',
  });

  assert.equal(acceso.apiKey, 'P9xKzQ2mNv7bT4rH');
  assert.equal(acceso.zoteroUserId, '8675309', 'sin el userID no se sabe qué biblioteca leer');
  assert.equal(acceso.username, 'tesista');
});

test('un canje sin userID se rechaza en vez de guardar una conexión inútil', async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => 'oauth_token_secret=P9xKzQ2mNv7bT4rH',
  });

  await assert.rejects(
    oauth.canjear({ token: 't', secreto: 's', verificador: 'v' }),
    /no devolvió la clave/,
  );
});
