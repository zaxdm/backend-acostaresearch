'use strict';

/**
 * Guardar un capítulo por partes que llegan a la vez.
 *
 * Claude llama a varias herramientas en paralelo. Con `anadir`, cada parte leía
 * el texto de antes, le pegaba la suya y escribía: dos a la vez leían lo mismo,
 * y la segunda en escribir borraba la primera, que ya había contestado
 * «Guardado». Además el temporal tenía siempre el mismo nombre y se truncaban el
 * uno al otro. Esto va contra el disco de verdad, en una carpeta temporal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let base;
const rutaEnv = require.resolve(path.join(__dirname, '../src/config/env'));
require.cache[rutaEnv] = {
  id: rutaEnv,
  filename: rutaEnv,
  loaded: true,
  exports: {
    get capitulosDir() {
      return path.join(base, 'capitulos');
    },
    get rSesionesDir() {
      return path.join(base, 'r');
    },
  },
};

const almacen = require('../src/modules/projects/project.storage');

test.before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'acosta-capitulos-'));
});

test.after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

test('veinte partes que llegan a la vez quedan todas, en orden de llegada', async () => {
  const partes = Array.from({ length: 20 }, (_, i) => `Parte ${String(i).padStart(2, '0')}.`);

  await almacen.guardar('p1', 'marco', 'Inicio.');
  await Promise.all(partes.map((texto) => almacen.guardar('p1', 'marco', texto, { anadir: true })));

  const final = await almacen.leer('p1', 'marco');
  assert.equal(final, ['Inicio.', ...partes].join('\n\n'));
});

test('no quedan temporales a medias en la carpeta', async () => {
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => almacen.guardarPagina('p2', { margen: { top: i } })),
  );
  const archivos = await fs.readdir(path.join(base, 'capitulos', 'p2'));
  assert.deepEqual(archivos, ['plantilla-pagina.json']);
});
