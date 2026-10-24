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

/** Responde según la ruta pedida: colecciones y sueltos por separado. */
function espiarPorRuta(t, respuestas) {
  const original = global.fetch;
  const pedidas = [];

  global.fetch = async (url) => {
    const u = new URL(url);
    pedidas.push(u);
    const ruta = u.pathname.replace(`/users/${CONTEXTO.zoteroUserId}`, '');
    const cuerpo = respuestas[ruta] ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get: (nombre) => {
          const n = nombre.toLowerCase();
          if (n === 'content-type') return 'application/json';
          if (n === 'total-results') return String(cuerpo.length);
          return null;
        },
      },
      json: async () => cuerpo,
      text: async () => JSON.stringify(cuerpo),
    };
  };

  t.after(() => {
    global.fetch = original;
  });

  return pedidas;
}

test('el número de una colección no cuenta sus PDF sueltos ni sus notas (24-oct)', async (t) => {
  const pdf = (n) => ({ key: `P${n}`, data: { itemType: 'attachment', collections: ['TESIS001'] } });
  espiarPorRuta(t, {
    '/collections': [
      { key: 'TESIS001', data: { name: 'ARTICULOS PARA TESIS' }, meta: { numItems: 20 } },
      { key: 'OTRA0001', data: { name: 'Otra' }, meta: { numItems: 5 } },
    ],
    '/items/top': [
      ...Array.from({ length: 18 }, (_, i) => pdf(i)),
      { key: 'NOTA0001', data: { itemType: 'note', collections: ['TESIS001'] } },
    ],
  });

  const lista = await cliente.colecciones(CONTEXTO);
  const tesis = lista.find((c) => c.clave === 'TESIS001');
  const otra = lista.find((c) => c.clave === 'OTRA0001');

  assert.equal(tesis.cuantas, 1, '20 en Zotero menos 18 PDF y 1 nota: entra 1');
  assert.equal(tesis.sinFicha, 18);
  assert.equal(otra.cuantas, 5);
  assert.equal(otra.sinFicha, 0);
});

test('los sueltos se piden solo de primer nivel: un PDF con su ficha no cuenta', async (t) => {
  const pedidas = espiarPorRuta(t, {});

  await cliente.colecciones(CONTEXTO);
  await cliente.cuantosPdfsSinFicha(CONTEXTO, 'TESIS001');
  await cliente.cuantosPdfsSinFicha(CONTEXTO, '*');

  const sueltos = pedidas.filter((u) => u.pathname.endsWith('/items/top'));
  assert.equal(sueltos.length, 3);
  assert.equal(sueltos[0].searchParams.get('itemType'), 'attachment || note');
  assert.equal(sueltos[1].pathname, `/users/${CONTEXTO.zoteroUserId}/collections/TESIS001/items/top`);
  assert.equal(sueltos[1].searchParams.get('itemType'), 'attachment');
  assert.equal(sueltos[2].pathname, `/users/${CONTEXTO.zoteroUserId}/items/top`);
});
