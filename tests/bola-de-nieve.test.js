'use strict';

/**
 * La bola de nieve: qué más leer, a partir de lo que el tesista ya tiene.
 *
 * Lo que se prueba es lo que la hace útil o inútil, que no es que llame a
 * OpenAlex:
 *
 *   · El orden. Hacia atrás se ordena por CUÁNTAS DE SUS FUENTES lo citan, no
 *     por cuántas citas tiene en el mundo. Un clásico famoso de otro campo no
 *     puede colarse por delante del trabajo que sostiene SU tema.
 *   · Que no le devuelva lo que ya tiene, ni por identificador ni por DOI.
 *   · Que una sola fuente citando algo no baste: eso es una mención de paso.
 *   · Que con pocas semillas se niegue a responder en vez de dar ruido con
 *     autoridad, que es la forma elegante de hacer perder el tiempo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

/** Su biblioteca: los DOI que ya tiene. */
const mios = { dois: [] };
sustituir('../src/modules/references/propias.repository', {
  TOPE_POR_USUARIO: 5000,
  doisDe: async () => mios.dois,
  contar: async () => mios.dois.length,
  guardarLote: async () => ({ guardadas: 0, repetidas: 0 }),
  contarSinResumen: async () => 0,
  resumen: async () => ({}),
  vaciar: async () => ({ borradas: 0 }),
});

/** OpenAlex: a quién cita cada semilla, y qué hay detrás de cada id. */
const openalex = {
  obras: [],
  fichas: {},
  citantes: [],
  pedidos: { ids: null, citanA: null },
};

sustituir('../src/modules/references/openalex.client', {
  limpiarDoi: (d) => (d ? String(d).toLowerCase() : null),
  referenciasDe: async () => openalex.obras,
  porIds: async (ids) => {
    openalex.pedidos.ids = ids;
    return ids.map((id) => openalex.fichas[id]).filter(Boolean);
  },
  citanA: async (ids, opciones) => {
    openalex.pedidos.citanA = { ids, opciones };
    return openalex.citantes;
  },
  porDoi: async () => null,
  buscar: async () => ({ fuentes: [], total: 0, caida: false }),
});

sustituir('../src/modules/references/crossref.client', {
  completar: async (f) => f,
  porDoi: async () => null,
});

const propias = require('../src/modules/references/propias.service');

/** Una ficha de OpenAlex, con lo justo. */
const obra = (id, titulo, { doi = null, citas = 0, anio = 2015 } = {}) => ({
  id,
  doi: doi ?? `10.9999/${id.toLowerCase()}`,
  title: titulo,
  authors: 'Autor, A.',
  year: anio,
  source: 'Una revista',
  citas,
});

function empezar() {
  mios.dois = ['10.1/a', '10.2/b', '10.3/c', '10.4/d', '10.5/e'];
  openalex.obras = [];
  openalex.fichas = {};
  openalex.citantes = [];
  openalex.pedidos = { ids: null, citanA: null };
}

// ── Las pruebas ─────────────────────────────────────────────────────────────

test('lo que citan MÁS fuentes suyas va primero, aunque otro tenga más citas', async () => {
  empezar();

  // Cuatro de sus cinco fuentes citan W_SUYO. Solo dos citan W_FAMOSO, que en
  // cambio tiene cuarenta mil citas en el mundo entero.
  openalex.obras = [
    { id: 'S1', doi: '10.1/a', referencias: ['W_SUYO', 'W_FAMOSO'] },
    { id: 'S2', doi: '10.2/b', referencias: ['W_SUYO', 'W_FAMOSO'] },
    { id: 'S3', doi: '10.3/c', referencias: ['W_SUYO'] },
    { id: 'S4', doi: '10.4/d', referencias: ['W_SUYO'] },
    { id: 'S5', doi: '10.5/e', referencias: [] },
  ];
  openalex.fichas = {
    W_SUYO: obra('W_SUYO', 'El que sostiene su tema', { citas: 300 }),
    W_FAMOSO: obra('W_FAMOSO', 'Un clásico de otro campo', { citas: 40000 }),
  };

  const { atras } = await propias.boladeNieve('u1');

  assert.equal(atras[0].title, 'El que sostiene su tema');
  assert.equal(atras[0].tuyasQueLoCitan, 4);
  assert.equal(atras[1].tuyasQueLoCitan, 2);
});

test('lo que ya tiene no se le vuelve a ofrecer, ni por id ni por DOI', async () => {
  empezar();

  openalex.obras = [
    // S2 es una fuente suya, y otras dos la citan: no puede aparecer como
    // «descubrimiento».
    { id: 'S1', doi: '10.1/a', referencias: ['S2', 'W_NUEVO'] },
    { id: 'S2', doi: '10.2/b', referencias: ['W_NUEVO'] },
    { id: 'S3', doi: '10.3/c', referencias: ['S2', 'W_YA_LA_TENGO'] },
    { id: 'S4', doi: '10.4/d', referencias: ['W_YA_LA_TENGO'] },
    { id: 'S5', doi: '10.5/e', referencias: [] },
  ];
  openalex.fichas = {
    W_NUEVO: obra('W_NUEVO', 'Una que no tiene'),
    // Esta la tiene subida por otro camino: mismo DOI, otro identificador.
    W_YA_LA_TENGO: obra('W_YA_LA_TENGO', 'Ya la subió desde Scopus', { doi: '10.5/e' }),
  };

  const { atras } = await propias.boladeNieve('u1');

  const titulos = atras.map((f) => f.title);
  assert.deepEqual(titulos, ['Una que no tiene']);
});

test('una sola fuente citando algo no basta: eso es una mención de paso', async () => {
  empezar();

  openalex.obras = [
    { id: 'S1', doi: '10.1/a', referencias: ['W_UNICA'] },
    { id: 'S2', doi: '10.2/b', referencias: [] },
    { id: 'S3', doi: '10.3/c', referencias: [] },
    { id: 'S4', doi: '10.4/d', referencias: [] },
    { id: 'S5', doi: '10.5/e', referencias: [] },
  ];
  openalex.fichas = { W_UNICA: obra('W_UNICA', 'La cita una sola') };

  const { atras } = await propias.boladeNieve('u1');

  assert.equal(atras.length, 0);
  assert.equal(openalex.pedidos.ids.length, 0, 'ni se pide su ficha: se descarta antes');
});

test('con menos de cinco semillas se niega, y dice qué hacer', async () => {
  empezar();
  mios.dois = ['10.1/a', '10.2/b'];

  await assert.rejects(propias.boladeNieve('u1'), (fallo) => {
    assert.match(fallo.message, /tienes 2/);
    assert.match(fallo.message, /export|Zotero/);
    return true;
  });
});

test('hacia delante se excluye lo suyo y se acota por año', async () => {
  empezar();

  openalex.obras = [{ id: 'S1', doi: '10.1/a', referencias: [] }];
  openalex.citantes = [
    obra('W_RECIENTE', 'Publicado después', { anio: 2025 }),
    obra('W_ES_MIA', 'Pero esta ya es suya', { doi: '10.3/c', anio: 2024 }),
  ];

  const { adelante } = await propias.boladeNieve('u1', { desdeAnio: 2024 });

  assert.deepEqual(
    adelante.map((f) => f.title),
    ['Publicado después'],
  );
  assert.equal(openalex.pedidos.citanA.opciones.desdeAnio, 2024);
});

test('si el catálogo no responde, se dice: no se devuelve una lista vacía a secas', async () => {
  empezar();
  openalex.obras = [];

  const resultado = await propias.boladeNieve('u1');

  assert.equal(resultado.caida, true);
  assert.deepEqual(resultado.atras, []);
});
