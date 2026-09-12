'use strict';

/**
 * El Zotero de cada tesista, de la colección a su biblioteca de aquí.
 *
 * Cinco cosas tienen que ser ciertas, y son las cinco que se pueden romper sin
 * que salte nada evidente:
 *
 *   · Sus fuentes NO entran por `zoteroKey`. Esa columna es única en toda la
 *     tabla y las claves de ítem de Zotero solo son únicas dentro de su propia
 *     biblioteca: dos tesistas pueden traer la misma y el segundo pisaría al
 *     primero, o al corpus de la casa. Entran por `sourceRef`, con su cuenta
 *     delante.
 *   · Lo que él SACA de la colección desaparece de aquí. Es lo que hace de
 *     verdad —descartar una fuente— y para «lo borrado en Zotero» eso no ha
 *     ocurrido: el ítem sigue vivo en su biblioteca.
 *   · La limpieza no puede llevarse por delante lo que subió desde Scopus, que
 *     no viene de ninguna colección.
 *   · El turno se suelta aunque la pasada falle. Un cerrojo que se queda puesto
 *     bloquea a esa persona para siempre y en silencio.
 *   · Una clave revocada se cuenta como tal y se le dice qué hacer, en vez de
 *     dejarle un «403» en el panel.
 *
 * Zotero, la base y el cifrado se sustituyen antes de cargar el servicio: lo que
 * se comprueba es qué se escribe y qué se borra, no cómo se habla con nadie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const ZOTERO_USER_ID = '8675309';

// ── Lo que se sustituye ─────────────────────────────────────────────────────

const env = { zoteroOauthEnabled: true, APP_URL: 'https://acostaresearch.com' };
sustituir('../src/config/env', env);
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

// El cifrado tiene su propia prueba; aquí solo estorba.
sustituir('../src/shared/utils/secretos', { cifrar: (t) => t, descifrar: (t) => t });

/** La base: la fila de la conexión y lo que se le pide borrar. */
const baseDeDatos = {
  cuenta: null,
  turnoTomado: false,
  turnoSoltado: false,
  pasada: null,
  fallo: null,
  borradoCon: null,
  cuantasDeZotero: 0,
};

const repositorio = {
  prefijoDe: (id) => `zotero:users/${id}:`,
  deUsuario: async () => baseDeDatos.cuenta,
  tomarElTurno: async () => baseDeDatos.turnoTomado,
  soltarElTurno: async () => {
    baseDeDatos.turnoSoltado = true;
  },
  guardarPasada: async (_userId, datos) => {
    baseDeDatos.pasada = datos;
  },
  anotarFallo: async (_userId, mensaje) => {
    baseDeDatos.fallo = mensaje;
  },
  elegirColeccion: async (_userId, datos) => {
    baseDeDatos.cuenta = { ...baseDeDatos.cuenta, ...datos, libraryVersion: 0 };
  },
  borrarLasQueYaNoEstan: async (userId, zoteroUserId, clavesVivas) => {
    baseDeDatos.borradoCon = { userId, zoteroUserId, clavesVivas };
    return 1;
  },
  contarDeZotero: async () => baseDeDatos.cuantasDeZotero,
  desconectar: async () => {
    baseDeDatos.cuenta = null;
  },
};
sustituir('../src/modules/zotero/biblioteca.repository', repositorio);

/** Zotero: la colección que hay y lo que devuelve. */
const zotero = {
  colecciones: [{ clave: 'ABCD1234', nombre: 'Tesis › Antecedentes', cuantas: 2 }],
  enLaBiblioteca: 214,
  items: [],
  clavesVivas: [],
  revocada: false,
};

const cliente = {
  TODA_LA_BIBLIOTECA: '*',
  colecciones: async () => zotero.colecciones,
  cuantasEnLaBiblioteca: async () => zotero.enLaBiblioteca,
  paginasDeItems: async function* () {
    if (zotero.revocada) {
      const fallo = new Error('Zotero ya no acepta esta conexión.');
      fallo.revocada = true;
      throw fallo;
    }
    if (zotero.items.length > 0) {
      yield { items: zotero.items, versionBiblioteca: 4242, total: zotero.items.length };
    }
  },
  clavesDeLaColeccion: async () => zotero.clavesVivas,
};
sustituir('../src/modules/zotero/biblioteca.client', cliente);

/** Su biblioteca de aquí: lo que se escribe de verdad. */
const escritas = [];
const propias = {
  TOPE_POR_USUARIO: 5000,
  contar: async () => propias.yaTiene,
  yaTiene: 0,
  guardarLote: async (_userId, filas) => {
    escritas.push(...filas);
    return { guardadas: filas.length, repetidas: 0 };
  },
};
sustituir('../src/modules/references/propias.repository', propias);

const servicio = require('../src/modules/zotero/biblioteca.service');

// ── Un ítem de Zotero de los de verdad ──────────────────────────────────────

const articulo = (clave, titulo) => ({
  key: clave,
  version: 4242,
  data: {
    key: clave,
    itemType: 'journalArticle',
    title: titulo,
    creators: [{ creatorType: 'author', lastName: 'Hernández', firstName: 'Roberto' }],
    date: '2024-03-15',
    publicationTitle: 'Revista de Educación',
    DOI: '10.1234/re.2024.001',
    abstractNote: 'Un resumen cualquiera.',
    tags: [{ tag: 'metodología' }],
  },
});

function empezar({ coleccion = 'ABCD1234', version = 0 } = {}) {
  escritas.length = 0;
  propias.yaTiene = 0;
  Object.assign(baseDeDatos, {
    cuenta: {
      userId: 'u1',
      zoteroUserId: ZOTERO_USER_ID,
      username: 'tesista',
      apiKeyCipher: 'P9xKzQ2mNv7bT4rH',
      collectionKey: coleccion,
      collectionName: 'Tesis › Antecedentes',
      libraryVersion: version,
      lastCount: 0,
      runningSince: null,
      lastError: null,
    },
    turnoTomado: true,
    turnoSoltado: false,
    pasada: null,
    fallo: null,
    borradoCon: null,
    cuantasDeZotero: 0,
  });
  Object.assign(zotero, { items: [], clavesVivas: [], revocada: false });
}

// ── Las pruebas ─────────────────────────────────────────────────────────────

test('una fuente suya no puede chocar con el corpus de la casa', async () => {
  empezar();
  zotero.items = [articulo('WXYZ9999', 'Clima organizacional y desempeño')];
  zotero.clavesVivas = ['WXYZ9999'];

  await servicio.sincronizar('u1');

  assert.equal(escritas.length, 1);
  const fila = escritas[0];

  assert.equal(fila.zoteroKey, null, 'la columna única de la casa se deja en nulo a propósito');
  assert.equal(fila.sourceRef, `zotero:users/${ZOTERO_USER_ID}:WXYZ9999`);
  assert.equal(fila.origin, 'ZOTERO');

  // Y la ficha llega entera: se cita con esto.
  assert.equal(fila.title, 'Clima organizacional y desempeño');
  assert.equal(fila.year, 2024);
  assert.equal(fila.doi, '10.1234/re.2024.001');
  assert.match(fila.authors, /Hernández/);
});

test('dos tesistas con el mismo artículo no comparten identidad', async () => {
  empezar();
  zotero.items = [articulo('WXYZ9999', 'El mismo artículo')];
  zotero.clavesVivas = ['WXYZ9999'];
  await servicio.sincronizar('u1');
  const deUno = escritas[0].sourceRef;

  empezar();
  baseDeDatos.cuenta.zoteroUserId = '1111111';
  zotero.items = [articulo('WXYZ9999', 'El mismo artículo')];
  zotero.clavesVivas = ['WXYZ9999'];
  await servicio.sincronizar('u2');
  const deOtro = escritas[0].sourceRef;

  assert.notEqual(deUno, deOtro, 'la misma clave de ítem en dos bibliotecas es un choque');
});

test('lo que saca de la colección se va de aquí, aunque siga en su Zotero', async () => {
  empezar({ version: 100 });
  zotero.items = [];
  zotero.clavesVivas = ['SIGUEAQU'];

  const resultado = await servicio.sincronizar('u1');

  assert.deepEqual(baseDeDatos.borradoCon.clavesVivas, ['SIGUEAQU']);
  assert.equal(baseDeDatos.borradoCon.userId, 'u1');
  assert.equal(
    baseDeDatos.borradoCon.zoteroUserId,
    ZOTERO_USER_ID,
    'sin acotar por su cuenta, la limpieza alcanza lo que no es de esta colección',
  );
  assert.equal(resultado.retiradas, 1);
});

test('la pasada guarda hasta qué versión llegó, para que la siguiente sea incremental', async () => {
  empezar({ version: 0 });
  zotero.items = [articulo('WXYZ9999', 'Una fuente')];
  zotero.clavesVivas = ['WXYZ9999'];
  baseDeDatos.cuantasDeZotero = 1;

  await servicio.sincronizar('u1');

  assert.deepEqual(baseDeDatos.pasada, { libraryVersion: 4242, lastCount: 1 });
});

test('sin colección elegida no se trae nada, y se dice por qué', async () => {
  empezar({ coleccion: null });

  await assert.rejects(servicio.sincronizar('u1'), /Elige primero qué colección/);
  assert.equal(escritas.length, 0);
});

test('si ya hay una pasada en marcha, la segunda no entra', async () => {
  empezar();
  baseDeDatos.turnoTomado = false;

  await assert.rejects(servicio.sincronizar('u1'), /Ya se está trayendo tu biblioteca/);
  assert.equal(escritas.length, 0);
});

test('el turno se suelta aunque la pasada falle', async () => {
  empezar();
  zotero.revocada = true;

  await assert.rejects(servicio.sincronizar('u1'));

  assert.equal(baseDeDatos.turnoSoltado, true, 'un cerrojo sin soltar la bloquea para siempre');
});

test('una clave revocada se explica en sus palabras, no con un 403', async () => {
  empezar();
  zotero.revocada = true;

  await assert.rejects(servicio.sincronizar('u1'));

  assert.match(baseDeDatos.fallo, /Vuelve a conectar/);
});

test('el tope por usuario se respeta: se traen las que caben y se para', async () => {
  empezar();
  propias.yaTiene = propias.TOPE_POR_USUARIO - 2;
  zotero.items = [
    articulo('AAAAAAAA', 'Una'),
    articulo('BBBBBBBB', 'Dos'),
    articulo('CCCCCCCC', 'Tres'),
  ];
  zotero.clavesVivas = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC'];

  await servicio.sincronizar('u1');

  assert.equal(escritas.length, 2, 'la tercera no cabía y no se escribe');
});

test('solo se puede elegir una colección que sea suya', async () => {
  empezar({ coleccion: null });

  await assert.rejects(servicio.elegir('u1', 'NOESMIA1'), /no está en tu Zotero/);
});

test('elegir colección deja el marcador de versión a cero', async () => {
  empezar({ coleccion: 'OTRACOSA', version: 999 });

  await servicio.elegir('u1', 'ABCD1234');

  assert.equal(baseDeDatos.cuenta.collectionKey, 'ABCD1234');
  assert.equal(
    baseDeDatos.cuenta.libraryVersion,
    0,
    'conservar la versión de la colección anterior deja la nueva a medias',
  );
});

test('la lista incluye la biblioteca entera, con cuántas fuentes tiene', async () => {
  empezar();

  const { biblioteca, colecciones } = await servicio.colecciones('u1');

  assert.equal(biblioteca.clave, '*');
  assert.equal(
    biblioteca.cuantas,
    214,
    'sin el número, elegir «toda mi biblioteca» es firmar en blanco',
  );
  assert.equal(colecciones.length, 1);
});

test('quien no usa carpetas puede traerlo todo, sin crear ninguna', async () => {
  // Su Zotero está como el de mucha gente: sin una sola colección.
  empezar({ coleccion: null });
  zotero.colecciones = [];

  const { coleccion } = await servicio.elegir('u1', '*');

  assert.equal(coleccion.clave, '*');
  assert.equal(baseDeDatos.cuenta.collectionKey, '*');
  assert.equal(baseDeDatos.cuenta.collectionName, 'Toda tu biblioteca');

  zotero.colecciones = [{ clave: 'ABCD1234', nombre: 'Tesis › Antecedentes', cuantas: 2 }];
});

test('sin Zotero conectado, el panel lo dice sin inventarse una cuenta', async () => {
  empezar();
  baseDeDatos.cuenta = null;

  assert.deepEqual(await servicio.estado('u1'), { disponible: true, conectado: false });
});

test('desconectar quita la conexión y NO las fuentes ya traídas', async () => {
  empezar();
  zotero.items = [articulo('WXYZ9999', 'Ya citada en su capítulo II')];
  zotero.clavesVivas = ['WXYZ9999'];
  await servicio.sincronizar('u1');

  const cuantasAntes = escritas.length;
  await servicio.desconectar('u1');

  assert.equal(baseDeDatos.cuenta, null);
  assert.equal(escritas.length, cuantasAntes, 'borrarlas dejaría su tesis con citas rotas');
});
