'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Una fuente no entra dos veces en la biblioteca de un tesista por venir por
 * dos caminos.
 *
 * El índice único mira `sourceRef`, que dice POR DÓNDE entró —su Zotero, un
 * export, un DOI suelto—, así que el mismo artículo de su colección y añadido
 * por DOI eran dos filas. Se prueba que el DOI ya presente por otro camino no
 * crea otra, que volver a subir lo mismo sigue refrescando la ficha, y que las
 * fuentes sin DOI siguen entrando.
 *
 * Y al revés: si la fuente ya estaba por DOI y luego llega de su Zotero o su
 * Mendeley, no se descarta como repetida —el tesista veía 7 «de tu Zotero» de
 * una biblioteca de 54 (10-oct-2026)—: adopta la fila que había, con su mismo
 * `id`, para que las citas ya escritas sigan valiendo.
 */

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const base = { filas: [], upserts: [], updates: [] };

sustituir('../src/lib/prisma', {
  reference: {
    findMany: async ({ where, select }) => {
      const suyas = base.filas.filter((f) => f.ownerUserId === where.ownerUserId);
      if (where.sourceRef) return suyas.filter((f) => where.sourceRef.in.includes(f.sourceRef));
      // MySQL compara el DOI sin mayúsculas: se imita.
      const buscados = where.doi.in.map((d) => d.toLowerCase());
      return suyas
        .filter((f) => f.doi && buscados.includes(f.doi.toLowerCase()))
        .map((f) => Object.fromEntries(Object.keys(select).map((k) => [k, f[k]])));
    },
    findUnique: async ({ where }) => {
      const clave = where.ownerUserId_sourceRef;
      return (
        base.filas.find((f) => f.ownerUserId === clave.ownerUserId && f.sourceRef === clave.sourceRef) ??
        null
      );
    },
    update: async ({ where, data }) => {
      base.updates.push({ id: where.id, data });
      Object.assign(
        base.filas.find((f) => f.id === where.id),
        data,
      );
    },
    upsert: async ({ where, create }) => {
      base.upserts.push(where.ownerUserId_sourceRef.sourceRef);
      const clave = where.ownerUserId_sourceRef;
      if (!base.filas.some((f) => f.ownerUserId === clave.ownerUserId && f.sourceRef === clave.sourceRef)) {
        base.filas.push(create);
      }
    },
  },
});

const { guardarLote } = require('../src/modules/references/propias.repository');

function empezar(filas = []) {
  base.filas = filas;
  base.upserts = [];
  base.updates = [];
}

const DOI = '10.1186/s43093-025-00476-z';

test('el mismo DOI que ya vino de su Zotero no crea otra fila al añadirlo por DOI', async () => {
  empezar([{ ownerUserId: 'u1', sourceRef: 'zotero:users/8675309:WXYZ9999', doi: DOI }]);

  const resultado = await guardarLote('u1', [{ sourceRef: `doi:${DOI}`, doi: DOI.toUpperCase(), title: 'Hassan' }]);

  assert.deepEqual(resultado, { guardadas: 0, repetidas: 1 });
  assert.equal(base.upserts.length, 0);
  assert.equal(base.filas.length, 1);
});

test('volver a subir lo mismo por el mismo camino sigue refrescando la ficha', async () => {
  empezar([{ ownerUserId: 'u1', sourceRef: `doi:${DOI}`, doi: DOI }]);

  const resultado = await guardarLote('u1', [{ sourceRef: `doi:${DOI}`, doi: DOI, title: 'Hassan corregido' }]);

  assert.deepEqual(resultado, { guardadas: 0, repetidas: 1 });
  assert.deepEqual(base.upserts, [`doi:${DOI}`], 'la ficha se refresca, no se salta');
});

test('dos filas del mismo lote con el mismo DOI entran una sola vez', async () => {
  empezar();

  const resultado = await guardarLote('u1', [
    { sourceRef: 'scopus:2-s2.0-1', doi: DOI, title: 'Hu y Lee' },
    { sourceRef: 'wos:000123', doi: DOI, title: 'Hu y Tatum Lee' },
  ]);

  assert.deepEqual(resultado, { guardadas: 1, repetidas: 1 });
  assert.equal(base.filas.length, 1);
});

test('las fuentes sin DOI entran siempre: no hay con qué compararlas', async () => {
  empezar([{ ownerUserId: 'u1', sourceRef: 'scopus:uno', doi: null }]);

  const resultado = await guardarLote('u1', [
    { sourceRef: 'scopus:dos', doi: null, title: 'Libro sin DOI' },
    { sourceRef: 'scopus:tres', doi: '', title: 'Tesis sin DOI' },
  ]);

  assert.deepEqual(resultado, { guardadas: 2, repetidas: 0 });
});

test('el DOI de otro tesista no cuenta como repetido', async () => {
  empezar([{ ownerUserId: 'otro', sourceRef: `doi:${DOI}`, doi: DOI }]);

  const resultado = await guardarLote('u1', [{ sourceRef: `doi:${DOI}`, doi: DOI }]);

  assert.deepEqual(resultado, { guardadas: 1, repetidas: 0 });
});

// ── La de su gestor adopta la que ya estaba ────────────────────────────────

const porDoi = () => ({
  id: 'fila-1',
  ownerUserId: 'u1',
  sourceRef: `doi:${DOI}`,
  origin: 'SCOPUS',
  doi: DOI,
  title: 'Hassan (Crossref)',
  abstract: 'El resumen que se trajo por DOI.',
  busqueda: 'hassan crossref el resumen que se trajo por doi',
});

const deZotero = (mas = {}) => ({
  sourceRef: 'zotero:users/8675309:WXYZ9999',
  origin: 'ZOTERO',
  doi: DOI.toUpperCase(),
  title: 'Hassan (como lo tiene en Zotero)',
  abstract: null,
  busqueda: 'hassan zotero',
  ...mas,
});

test('la fuente que ya tenía por DOI pasa a ser la de su Zotero, en la misma fila', async () => {
  empezar([porDoi()]);

  const resultado = await guardarLote('u1', [deZotero()]);

  assert.deepEqual(resultado, { guardadas: 0, repetidas: 0, adoptadas: 1 });
  assert.equal(base.filas.length, 1, 'no se crea otra fila');
  assert.equal(base.upserts.length, 0);

  const fila = base.filas[0];
  assert.equal(fila.id, 'fila-1', 'mismo id: la clave de cita no cambia');
  assert.equal(fila.sourceRef, 'zotero:users/8675309:WXYZ9999');
  assert.equal(fila.origin, 'ZOTERO');
  assert.equal(fila.title, 'Hassan (como lo tiene en Zotero)');
  // Zotero no traía resumen: se queda el que había, y su texto de búsqueda.
  assert.equal(fila.abstract, 'El resumen que se trajo por DOI.');
  assert.equal(fila.busqueda, 'hassan crossref el resumen que se trajo por doi');
});

test('la siguiente pasada ya la encuentra como suya y solo la refresca', async () => {
  empezar([porDoi()]);
  await guardarLote('u1', [deZotero()]);

  const otra = await guardarLote('u1', [deZotero({ title: 'Hassan corregido' })]);

  assert.deepEqual(otra, { guardadas: 0, repetidas: 1 });
  assert.equal(base.updates.length, 1, 'no se adopta dos veces');
});

test('Mendeley también adopta, pero un gestor no le quita la fuente al otro', async () => {
  empezar([porDoi()]);
  const mendeley = { sourceRef: 'mendeley:perfil:abc', origin: 'MENDELEY', doi: DOI, title: 'Hassan' };
  assert.deepEqual(await guardarLote('u1', [mendeley]), { guardadas: 0, repetidas: 0, adoptadas: 1 });

  // Ya es de su Mendeley: su Zotero llega después y se queda como repetida.
  assert.deepEqual(await guardarLote('u1', [deZotero()]), { guardadas: 0, repetidas: 1 });
  assert.equal(base.filas[0].sourceRef, 'mendeley:perfil:abc');
});

test('dos ítems de su Zotero con el mismo DOI: el segundo sigue siendo repetido', async () => {
  empezar([porDoi()]);

  const resultado = await guardarLote('u1', [
    deZotero(),
    deZotero({ sourceRef: 'zotero:users/8675309:OTRO0000' }),
  ]);

  assert.deepEqual(resultado, { guardadas: 0, repetidas: 1, adoptadas: 1 });
  assert.equal(base.filas.length, 1);
});
