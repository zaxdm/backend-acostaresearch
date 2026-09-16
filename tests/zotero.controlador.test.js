'use strict';

/**
 * El controlador de Zotero, cargado de verdad.
 *
 * `zotero.navegador.test.js` prueba el servicio y nunca carga el controlador,
 * así que `conectar` salió a producción usando `env` sin importarlo: cada clic
 * en «Conectar Zotero» era un 500. Esto pasa por las dos rutas que ponen y
 * quitan la cookie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

sustituir('../src/config/env', {
  API_PREFIX: '/api/v1',
  COOKIE_SECURE: true,
  COOKIE_DOMAIN: undefined,
});
sustituir('../src/config/logger', { info() {}, warn() {}, error() {} });
sustituir('../src/modules/zotero/biblioteca.service', {
  empezar: async () => ({ url: 'https://www.zotero.org/oauth/authorize?oauth_token=t1', token: 't1' }),
  terminar: async () => ({ userId: 'u1' }),
  urlDelPanel: (resultado) => `https://acostaresearch.com/perfil?zotero=${resultado}`,
});

const controlador = require('../src/modules/zotero/biblioteca.controller');

/** Llama a un manejador de `asyncHandler` y espera a que responda o falle. */
function llamar(manejador, req) {
  return new Promise((resolve, reject) => {
    const res = {
      cookies: [],
      borradas: [],
      cookie(nombre, valor, opciones) { this.cookies.push({ nombre, valor, opciones }); return this; },
      clearCookie(nombre, opciones) { this.borradas.push({ nombre, opciones }); return this; },
      status(codigo) { this.codigo = codigo; return this; },
      json(cuerpo) { this.cuerpo = cuerpo; resolve(this); return this; },
      redirect(url) { this.redirigida = url; resolve(this); return this; },
    };
    manejador(req, res, reject);
  });
}

test('conectar responde la URL y deja la cookie en las rutas de Zotero', async () => {
  const res = await llamar(controlador.conectar, { user: { id: 'u1' } });

  assert.match(JSON.stringify(res.cuerpo), /oauth_token=t1/);
  assert.equal(res.cookies.length, 1);
  const [cookie] = res.cookies;
  assert.equal(cookie.nombre, 'zotero_oauth');
  assert.equal(cookie.valor, 't1');
  assert.equal(cookie.opciones.path, '/api/v1/mi-zotero');
  assert.equal(cookie.opciones.httpOnly, true);
  assert.equal(cookie.opciones.secure, true);
});

test('la vuelta borra la cookie y lleva al panel', async () => {
  const res = await llamar(controlador.vuelta, {
    query: { oauth_token: 't1', oauth_verifier: 'v' },
    cookies: { zotero_oauth: 't1' },
  });

  assert.equal(res.borradas[0].nombre, 'zotero_oauth');
  assert.equal(res.redirigida, 'https://acostaresearch.com/perfil?zotero=ok');
});
