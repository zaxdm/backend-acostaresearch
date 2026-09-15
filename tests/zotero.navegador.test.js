'use strict';

/**
 * Conectar Zotero solo puede terminarlo el navegador que lo empezó.
 *
 * El ataque que esto cierra: alguien pulsa «conectar» con SU cuenta, copia la
 * dirección de autorización de zotero.org y se la manda a un tesista. Si el
 * tesista autoriza, su clave de Zotero quedaba guardada en la cuenta del otro,
 * que se llevaba su biblioteca entera. La identidad salía de la fila guardada
 * al empezar, y esa fila era del atacante.
 *
 * Ahora el navegador que empieza recibe el token en una cookie httpOnly y la
 * vuelta exige que coincida.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const estado = { peticiones: new Map(), conexiones: [] };

sustituir('../src/config/env', { zoteroOauthEnabled: true, APP_URL: 'https://acostaresearch.com' });
sustituir('../src/config/logger', { info() {}, warn() {}, error() {} });
sustituir('../src/shared/utils/secretos', { cifrar: (v) => `cifrado:${v}`, descifrar: (v) => String(v).replace('cifrado:', '') });
sustituir('../src/modules/zotero/oauth1', {
  pedirTokenTemporal: async () => ({ token: 'token-del-atacante', secreto: 'secreto' }),
  urlDeAutorizacion: (token) => `https://www.zotero.org/oauth/authorize?oauth_token=${token}`,
  canjear: async () => ({ zoteroUserId: '999', username: 'victima', apiKey: 'clave-de-la-victima' }),
});
sustituir('../src/modules/zotero/biblioteca.repository', {
  guardarPeticion: async ({ token, secretCipher, userId }) => {
    estado.peticiones.set(token, { token, secretCipher, userId });
  },
  tomarPeticion: async (token) => {
    const fila = estado.peticiones.get(token);
    // Como el repositorio de verdad: la fila la reclama uno solo.
    if (fila) estado.peticiones.delete(token);
    return fila ?? null;
  },
  guardarConexion: async (datos) => estado.conexiones.push(datos),
});

const servicio = require('../src/modules/zotero/biblioteca.service');

test.beforeEach(() => {
  estado.peticiones.clear();
  estado.conexiones.length = 0;
});

test('empezar devuelve la URL y el token que el navegador guarda en su cookie', async () => {
  const { url, token } = await servicio.empezar('atacante');
  assert.equal(token, 'token-del-atacante');
  assert.match(url, /oauth_token=token-del-atacante/);
  assert.equal(estado.peticiones.size, 1);
});

test('la víctima que autoriza sin haber empezado aquí no conecta nada', async () => {
  await servicio.empezar('atacante');

  await assert.rejects(
    servicio.terminar({ token: 'token-del-atacante', verificador: 'v', tokenDelNavegador: undefined }),
    /otro navegador/,
  );
  assert.equal(estado.conexiones.length, 0, 'la clave de la víctima no puede quedar guardada');
  assert.equal(estado.peticiones.size, 1, 'y la petición sigue sin gastarse');
});

test('tampoco si su navegador traía el token de otro intercambio', async () => {
  await servicio.empezar('atacante');

  await assert.rejects(
    servicio.terminar({ token: 'token-del-atacante', verificador: 'v', tokenDelNavegador: 'otro-token' }),
    /otro navegador/,
  );
  assert.equal(estado.conexiones.length, 0);
});

test('el navegador que empezó sí termina, y su token solo sirve una vez', async () => {
  const { token } = await servicio.empezar('dueño');

  const hecho = await servicio.terminar({ token, verificador: 'v', tokenDelNavegador: token });
  assert.equal(hecho.userId, 'dueño');
  assert.equal(estado.conexiones.length, 1);
  assert.equal(estado.conexiones[0].userId, 'dueño');

  await assert.rejects(
    servicio.terminar({ token, verificador: 'v', tokenDelNavegador: token }),
    /ya se usó o caducó/,
  );
});
