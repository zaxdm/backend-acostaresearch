'use strict';

/**
 * Lo que este cliente le pide a Zotero, exactamente.
 *
 * Nace de un fallo que llegó a producción: el filtro de tipos iba escrito
 * `-attachment || -note`, que es lo que parece que hay que poner, y Zotero
 * contesta **400 «Invalid itemType '-note'»**. El menos niega la expresión
 * entera, no cada término, así que lo correcto es `-attachment || note`.
 *
 * No lo cazó ninguna prueba porque todas las demás sustituyen este cliente por
 * uno de mentira: se comprobaba qué se hace con lo que Zotero devuelve, nunca
 * qué se le pide. Estas miran la URL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaLogger = require.resolve('../src/config/logger');
require.cache[rutaLogger] = {
  id: rutaLogger,
  filename: rutaLogger,
  loaded: true,
  exports: { info: () => {}, warn: () => {}, error: () => {} },
};

const cliente = require('../src/modules/zotero/biblioteca.client');

const CONTEXTO = { zoteroUserId: '8675309', apiKey: 'P9xKzQ2mNv7bT4rH' };

/** Sustituye fetch y devuelve las URL que se pidieron. */
function espiar(t, { cuerpo = [], tipo = 'application/json' } = {}) {
  const original = global.fetch;
  const pedidas = [];

  global.fetch = async (url) => {
    pedidas.push(new URL(url));
    return {
      ok: true,
      status: 200,
      headers: {
        get: (nombre) => {
          const n = nombre.toLowerCase();
          if (n === 'content-type') return tipo;
          if (n === 'total-results') return String(Array.isArray(cuerpo) ? cuerpo.length : 0);
          return null;
        },
      },
      json: async () => cuerpo,
      text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    };
  };

  t.after(() => {
    global.fetch = original;
  });

  return pedidas;
}

test('el filtro de tipos es el que Zotero acepta, no el que parece', async (t) => {
  const pedidas = espiar(t);

  // eslint-disable-next-line no-empty
  for await (const _ of cliente.paginasDeItems(CONTEXTO, { collectionKey: 'ABCD1234' })) {
  }

  const itemType = pedidas[0].searchParams.get('itemType');
  assert.equal(itemType, '-attachment || note');
  assert.ok(
    !itemType.includes('|| -'),
    'un menos en el segundo término devuelve 400 «Invalid itemType»',
  );
});

test('las claves vivas se piden en una sola petición y en texto', async (t) => {
  const pedidas = espiar(t, { cuerpo: 'AAAAAAAA\nBBBBBBBB\n', tipo: 'text/plain' });

  const claves = await cliente.clavesDeLaColeccion(CONTEXTO, 'ABCD1234');

  assert.deepEqual(claves, ['AAAAAAAA', 'BBBBBBBB']);
  assert.equal(pedidas.length, 1, 'la lista entera cabe en una respuesta: no se pagina');
  assert.equal(pedidas[0].searchParams.get('format'), 'keys');
  assert.equal(pedidas[0].searchParams.get('itemType'), '-attachment || note');
});

test('«toda la biblioteca» pide /items, no una colección', async (t) => {
  const pedidas = espiar(t);

  // eslint-disable-next-line no-empty
  for await (const _ of cliente.paginasDeItems(CONTEXTO, { collectionKey: '*' })) {
  }
  await cliente.clavesDeLaColeccion(CONTEXTO, '*');

  for (const url of pedidas) {
    assert.equal(
      url.pathname,
      `/users/${CONTEXTO.zoteroUserId}/items`,
      'con el asterisco no hay colección en la ruta: sería /collections/*/items y un 404',
    );
    assert.equal(url.searchParams.get('itemType'), '-attachment || note');
  }
});

test('se lee la biblioteca de ESE tesista y no otra', async (t) => {
  const pedidas = espiar(t);

  await cliente.colecciones(CONTEXTO);

  assert.equal(pedidas[0].origin, 'https://api.zotero.org');
  assert.ok(
    pedidas[0].pathname.startsWith(`/users/${CONTEXTO.zoteroUserId}/`),
    'la ruta lleva su id de Zotero: sin eso se leería la biblioteca equivocada',
  );
});

test('la primera pasada no manda «since»; la segunda sí', async (t) => {
  const pedidas = espiar(t);

  // eslint-disable-next-line no-empty
  for await (const _ of cliente.paginasDeItems(CONTEXTO, { collectionKey: 'A', desdeVersion: 0 })) {
  }
  // eslint-disable-next-line no-empty
  for await (const _ of cliente.paginasDeItems(CONTEXTO, { collectionKey: 'A', desdeVersion: 42 })) {
  }

  assert.equal(pedidas[0].searchParams.get('since'), null, 'un since=0 pediría lo mismo dos veces');
  assert.equal(pedidas[1].searchParams.get('since'), '42');
});
