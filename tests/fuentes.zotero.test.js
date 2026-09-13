'use strict';

/**
 * Las fuentes del Zotero del tesista, vistas desde el conector.
 *
 * Se prueban las dos cosas que fallaban en uso con una colección de 580:
 *
 *   · Buscar. El tema llega en inglés porque el fondo de la casa lo está, y su
 *     Zotero suele estar en español. Sin la segunda pregunta en español, sus
 *     fuentes no salían y el conector le servía el catálogo abierto sin revisar.
 *   · Verlas sin tema. «Entra a mi carpeta de Zotero» no trae palabra que
 *     buscar, y ninguna herramienta respondía a eso.
 *
 * Sin base de datos: se sustituyen los repositorios y la licencia, y se llama a
 * los handlers de verdad a través de un `McpServer` que solo los apunta.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── La base, de mentira ────────────────────────────────────────────────────

/** Lo que devuelve la búsqueda según las palabras que le lleguen. */
const indice = { llamadas: [], responder: () => [] };
sustituir('../src/modules/references/reference.repository', {
  buscar: async (opciones) => {
    indice.llamadas.push(opciones);
    return indice.responder(opciones.palabras);
  },
});

/** Su biblioteca y su conexión de Zotero. */
const mia = { total: 0, deZotero: 0, cuenta: null, filas: [], pedidos: [] };
sustituir('../src/modules/references/propias.repository', {
  TOPE_POR_USUARIO: 5000,
  contar: async () => mia.total,
  contarDeZotero: async () => mia.deZotero,
  pagina: async (userId, { saltar, tomar, origen }) => {
    mia.pedidos.push({ userId, saltar, tomar, origen });
    const lista = mia.filas.filter((f) =>
      origen === 'zotero' ? f.origin === 'ZOTERO' : origen === 'subidas' ? f.origin !== 'ZOTERO' : true,
    );
    return { total: lista.length, fuentes: lista.slice(saltar, saltar + tomar) };
  },
  doisDe: async () => [],
  guardarLote: async () => ({ guardadas: 0, repetidas: 0 }),
  contarSinResumen: async () => 0,
  resumen: async () => ({}),
  vaciar: async () => 0,
});
sustituir('../src/modules/zotero/biblioteca.repository', {
  deUsuario: async () => mia.cuenta,
  prefijoDe: (id) => `zotero:users/${id}:`,
});
sustituir('../src/modules/licensing/license.service', {
  recordUsage: async () => {},
  reserveLimits: async () => ({ permitido: true }),
  releaseLimits: async () => {},
});

const ruta = require.resolve('@modelcontextprotocol/server');
const real = require('@modelcontextprotocol/server');
const herramientas = new Map();
require.cache[ruta] = {
  id: ruta,
  filename: ruta,
  loaded: true,
  exports: {
    fromJsonSchema: real.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config, handler) {
        herramientas.set(nombre, handler);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');
const { buscarParaLicencia } = require('../src/modules/references/reference.service');

construirServidor({
  id: 'L1',
  userId: 'U1',
  user: { id: 'U1' },
  productCode: 'METODO_DE_TESIS_HUMANIZADOR',
});

const llamar = async (nombre, argumentos = {}) =>
  (await herramientas.get(nombre)(argumentos)).content[0].text;

const ficha = (id, extra = {}) => ({
  id,
  ref: `AR${id.padStart(8, '0')}`,
  title: `Título ${id}`,
  authors: 'García, J.',
  year: 2021,
  source: 'Revista',
  itemType: 'journalArticle',
  ownerUserId: null,
  origin: 'ZOTERO',
  ...extra,
});

const deEspanol = (palabras) => palabras.includes('clima');

// ── Buscar en los dos idiomas ──────────────────────────────────────────────

test('con el tema en español, busca también en su biblioteca y pone las suyas primero', async () => {
  indice.llamadas = [];
  indice.responder = (palabras) =>
    deEspanol(palabras) ? [ficha('2', { ownerUserId: 'U1' })] : [ficha('1')];

  const fuentes = await buscarParaLicencia({
    tema: 'organizational climate',
    temaOriginal: 'clima organizacional',
    ownerUserId: 'U1',
  });

  assert.equal(indice.llamadas.length, 2);
  assert.deepEqual(
    fuentes.map((f) => [f.clave, f.deZotero]),
    [
      ['AR00000002', true],
      ['AR00000001', false],
    ],
  );
});

test('las palabras vacías del español no se exigen en la búsqueda', async () => {
  indice.llamadas = [];
  indice.responder = () => [];

  await buscarParaLicencia({
    tema: 'organizational climate',
    temaOriginal: 'clima organizacional de los docentes para la región',
    ownerUserId: 'U1',
  });

  assert.deepEqual(indice.llamadas[1].palabras, ['clima', 'organizacional', 'docentes', 'region']);
});

test('una fuente que sale en las dos búsquedas no se repite', async () => {
  const suya = ficha('3', { ownerUserId: 'U1' });
  indice.responder = () => [suya];

  const fuentes = await buscarParaLicencia({
    tema: 'burnout teachers',
    temaOriginal: 'burnout docentes',
    ownerUserId: 'U1',
  });

  assert.equal(fuentes.length, 1);
});

test('sin dueño, o con el mismo tema, no se pregunta dos veces', async () => {
  indice.responder = () => [];

  indice.llamadas = [];
  await buscarParaLicencia({ tema: 'organizational climate', temaOriginal: 'clima organizacional' });
  assert.equal(indice.llamadas.length, 1, 'sin dueño no hay biblioteca suya en español');

  indice.llamadas = [];
  await buscarParaLicencia({ tema: 'burnout', temaOriginal: 'burnout', ownerUserId: 'U1' });
  assert.equal(indice.llamadas.length, 1);
});

test('buscar_fuentes pasa el tema en español y cuenta las de su Zotero aparte', async () => {
  indice.llamadas = [];
  indice.responder = (palabras) => (deEspanol(palabras) ? [ficha('4', { ownerUserId: 'U1' })] : []);

  const texto = await llamar('buscar_fuentes', {
    tema: 'organizational climate',
    temaOriginal: 'clima organizacional',
  });

  assert.equal(indice.llamadas[0].ownerUserId, 'U1');
  assert.match(texto, /\[AR00000004\]/);
  assert.match(texto, /\[de tu Zotero\]/);
  assert.match(texto, /PROPIO TESISTA, no de la de Acosta: 1 de su Zotero/);
  assert.doesNotMatch(texto, /catálogo abierto con/, 'teniendo las suyas no se sale fuera');
});

// ── Verlas sin tema ────────────────────────────────────────────────────────

const coleccion = (cuantas) =>
  Array.from({ length: cuantas }, (_, i) => ficha(String(i + 1), { ownerUserId: 'U1' }));

test('mis_fuentes enseña lo que trajo su Zotero, de qué colección y con su clave', async () => {
  mia.total = 45;
  mia.deZotero = 45;
  mia.filas = coleccion(45);
  mia.pedidos = [];
  mia.cuenta = {
    collectionName: 'APRUEBA ZOTERO 2',
    lastRunAt: new Date('2026-09-13T15:00:00Z'),
    runningSince: null,
    lastError: null,
  };

  const texto = await llamar('mis_fuentes');

  assert.equal(mia.pedidos[0].userId, 'U1', 'solo su biblioteca, nunca la de otro');
  assert.match(texto, /45 fuentes/);
  assert.match(texto, /45 de su Zotero —de «APRUEBA ZOTERO 2», al día del .*2026—/);
  assert.match(texto, /^1\. \[AR00000001\]  García, J\. \(2021\)\. Título 1$/m);
  assert.match(texto, /Página 1 de 2/);
  assert.match(texto, /"pagina": 2/);
  assert.doesNotMatch(texto, /· Zotero/, 'si todas son de Zotero, no se marca cada una');
});

test('la segunda página sigue la numeración y ya no ofrece más', async () => {
  const texto = await llamar('mis_fuentes', { pagina: 2 });
  assert.match(texto, /^41\. \[AR00000041\]/m);
  assert.doesNotMatch(texto, /Hay más/);
});

test('una página que no existe se dice, no se devuelve vacía', async () => {
  assert.match(await llamar('mis_fuentes', { pagina: 9 }), /La página 9 no existe.*hay 2/);
});

test('con fuentes de las dos procedencias, cada una lleva su marca', async () => {
  mia.total = 2;
  mia.deZotero = 1;
  mia.filas = [ficha('1', { ownerUserId: 'U1' }), ficha('2', { ownerUserId: 'U1', origin: 'SCOPUS' })];

  const texto = await llamar('mis_fuentes');
  assert.match(texto, /· Zotero/);
  assert.match(texto, /· subida/);
  assert.match(texto, /1 que subió él/);
});

test('con Zotero conectado y sin colección elegida, se le dice lo que falta', async () => {
  mia.total = 0;
  mia.deZotero = 0;
  mia.filas = [];
  mia.cuenta = { collectionName: null, lastRunAt: null, runningSince: null, lastError: null };

  assert.match(await llamar('mis_fuentes'), /NO HA ELEGIDO QUÉ TRAER/);
});

test('sin Zotero ni fuentes, se le explica cómo traerlas', async () => {
  mia.cuenta = null;
  assert.match(await llamar('mis_fuentes'), /conectando su Zotero en «Tu Zotero»/);
});
