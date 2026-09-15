'use strict';

/**
 * Instantáneas: lo que hoy ven los compradores de tesis y de artículo, guardado
 * tal cual para que cualquier cambio que lo toque haga fallar una prueba.
 *
 * Existen por el producto nuevo de informes. Ese trabajo toca el conector, el
 * panorama y el Word, que usan todos los productos, y la regla es que tesis y
 * artículo no cambien ni una letra. Una prueba que busca tres frases con una
 * expresión regular deja pasar el resto; esto no.
 *
 * Para regenerarlas, SOLO cuando el cambio sea a propósito:
 *
 *   ACTUALIZAR_INSTANTANEAS=1 npm test
 *
 * y revisar el diff de esta carpeta antes de comitear.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function comparar(nombre, valor) {
  const esTexto = typeof valor === 'string';
  const archivo = path.join(__dirname, `${nombre}.${esTexto ? 'txt' : 'json'}`);
  // Por JSON y vuelta: quita los `undefined` y deja lo mismo que se guarda.
  const actual = esTexto ? valor : JSON.parse(JSON.stringify(valor));

  if (process.env.ACTUALIZAR_INSTANTANEAS === '1') {
    fs.writeFileSync(archivo, esTexto ? actual : `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  if (!fs.existsSync(archivo)) {
    assert.fail(`Falta la instantánea ${path.basename(archivo)}: genérala con ACTUALIZAR_INSTANTANEAS=1.`);
  }

  const guardado = fs.readFileSync(archivo, 'utf8');
  if (esTexto) {
    assert.equal(actual, guardado, `${nombre} cambió`);
  } else {
    assert.deepStrictEqual(actual, JSON.parse(guardado), `${nombre} cambió`);
  }
}

module.exports = { comparar };
