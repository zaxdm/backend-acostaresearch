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
 */

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const base = { filas: [], upserts: [] };

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
