'use strict';

/**
 * Las figuras de R, archivadas junto al análisis.
 *
 * Los PNG vivían SOLO en la sesión de R, que es efímera. Mientras la sesión
 * existía el Word salía con las imágenes dentro; en cuanto se limpiaba, la
 * misma tesis empezaba a descargarse con «[figura1_histogramas.png]» escrito en
 * medio del capítulo de Resultados, y no había forma de recuperarla sin volver
 * a correr el análisis. Se vio en una tesis de verdad, con el análisis de hacía
 * ocho días: índice de figuras montado, rótulos puestos y ninguna imagen.
 *
 * Va contra el disco de verdad, en una carpeta temporal, como el resto de las
 * pruebas del almacén.
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test.before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'acosta-figuras-'));
});

test.after(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

test('una figura guardada se vuelve a leer tal cual', async () => {
  await almacen.guardarFigura('proyecto1', 'figura1_histogramas.png', PNG);

  assert.deepEqual(await almacen.leerFigura('proyecto1', 'figura1_histogramas.png'), PNG);
});

test('una figura que no se guardó devuelve null, no revienta', async () => {
  assert.equal(await almacen.leerFigura('proyecto1', 'no-existe.png'), null);
});

test('las figuras de un proyecto no se ven desde otro', async () => {
  await almacen.guardarFigura('proyecto2', 'suya.png', PNG);

  assert.equal(await almacen.leerFigura('proyecto1', 'suya.png'), null);
});

test('un nombre con barras o con .. no escribe fuera de su carpeta', async () => {
  for (const nombre of ['../fuera.png', 'graficos/dentro.png', 'a/../../b.png', '.png']) {
    assert.equal(almacen.figuraValida(nombre), false, nombre);
    await assert.rejects(() => almacen.guardarFigura('proyecto1', nombre, PNG));
  }
});

test('solo PNG: es lo que la librería de imágenes sabe incrustar', async () => {
  assert.equal(almacen.figuraValida('grafico.svg'), false);
  assert.equal(almacen.figuraValida('grafico.pdf'), false);
  assert.equal(almacen.figuraValida('figura2_dispersion.png'), true);
  // La extensión en mayúsculas es la misma imagen.
  assert.equal(almacen.figuraValida('FIGURA.PNG'), true);
});

test('un archivo vacío no se archiva: sería una figura rota guardada para siempre', async () => {
  assert.equal(await almacen.guardarFigura('proyecto1', 'vacia.png', Buffer.alloc(0)), false);
  assert.equal(await almacen.leerFigura('proyecto1', 'vacia.png'), null);
});

test('volver a guardar la misma figura la sustituye', async () => {
  const otra = Buffer.concat([PNG, Buffer.from('mas datos')]);
  await almacen.guardarFigura('proyecto1', 'figura1_histogramas.png', otra);

  assert.deepEqual(await almacen.leerFigura('proyecto1', 'figura1_histogramas.png'), otra);
});
