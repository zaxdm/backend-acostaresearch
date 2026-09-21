'use strict';

/**
 * SERVICE_UNAVAILABLE es «la base no contesta», y la web lo lee como tal: tapa
 * el sitio entero con «estamos en mantenimiento».
 *
 * El 21-sep-2026 a las 10:26 Scopus tardó más de quince segundos en una
 * búsqueda, el cliente de Scopus devolvió ese código y el tesista se quedó
 * mirando la pantalla de mantenimiento con todo lo nuestro funcionando. Que un
 * servicio de fuera falle tiene su propio código; este solo lo pone el
 * manejador de errores cuando la base se cae.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function archivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) return archivosJs(ruta);
    return e.name.endsWith('.js') ? [ruta] : [];
  });
}

test('solo el manejador de errores de la base usa SERVICE_UNAVAILABLE', () => {
  const src = path.join(__dirname, '..', 'src');
  const permitido = path.join(src, 'middlewares', 'errorHandler.js');
  const culpables = archivosJs(src)
    .filter((f) => f !== permitido)
    .filter((f) => /ERROR_CODES\.SERVICE_UNAVAILABLE/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(src, f));
  assert.deepEqual(culpables, [], 'estos encenderían la pantalla de mantenimiento de la web');
});
