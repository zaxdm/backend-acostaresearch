'use strict';

/**
 * Las búsquedas guardadas: cada uno solo ve, cambia y borra las suyas, y el
 * historial no pasa de su techo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const filas = [];
let siguiente = 1;
const coincide = (fila, where = {}) =>
  Object.entries(where).every(([k, v]) =>
    v && typeof v === 'object' && 'in' in v ? v.in.includes(fila[k]) : fila[k] === v,
  );

sustituir('../src/lib/prisma', {
  scopusBusqueda: {
    findMany: async ({ where, skip = 0, take }) =>
      filas
        .filter((f) => coincide(f, where))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(skip, take ? skip + take : undefined),
    findFirst: async ({ where }) => filas.find((f) => coincide(f, where)) ?? null,
    create: async ({ data }) => {
      const fila = { id: `id-${siguiente}`, ...data, updatedAt: siguiente };
      siguiente += 1;
      filas.push(fila);
      return fila;
    },
    update: async ({ where, data }) => Object.assign(filas.find((f) => f.id === where.id), data),
    deleteMany: async ({ where }) => {
      const antes = filas.length;
      for (let i = filas.length - 1; i >= 0; i -= 1) if (coincide(filas[i], where)) filas.splice(i, 1);
      return { count: antes - filas.length };
    },
  },
});

const guardadas = require('../src/modules/scopus/scopus.guardadas');

const nueva = { tipo: 'BUSQUEDA', titulo: 'T', ecuacion: 'TITLE(x)', estado: {} };

test('lo de otro no existe: ni se ve, ni se cambia, ni se borra', async () => {
  const mia = await guardadas.crear('yo', nueva);

  await assert.rejects(() => guardadas.una('otro', mia.id), /ya no existe/);
  await assert.rejects(() => guardadas.actualizar('otro', mia.id, { titulo: 'X' }), /ya no existe/);
  await assert.rejects(() => guardadas.borrar('otro', mia.id), /ya no existe/);
  assert.equal((await guardadas.una('yo', mia.id)).titulo, 'T');
});

test('al pasar del techo se va la más antigua, y guardar no falla', async () => {
  filas.length = 0;
  for (let i = 0; i < guardadas.MAXIMO_POR_USUARIO + 3; i += 1) {
    await guardadas.crear('lleno', { ...nueva, titulo: `n${i}` });
  }
  const mias = filas.filter((f) => f.userId === 'lleno');
  assert.equal(mias.length, guardadas.MAXIMO_POR_USUARIO);
  assert.ok(!mias.some((f) => f.titulo === 'n0'), 'la primera se fue');
});
