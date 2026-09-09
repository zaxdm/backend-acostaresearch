'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resumenDelIndice } = require('../src/modules/references/openalex.client');

/**
 * El resumen viene troceado, y hay que rehacerlo.
 *
 * OpenAlex no guarda el resumen como texto seguido: guarda cada palabra con las
 * posiciones donde aparece, por cómo están licenciados los resúmenes. Si esto
 * falla, el tesista recibe una ficha sin resumen —media ficha— porque el resumen
 * es justo por donde decide si la fuente le sirve o no.
 *
 * Se prueba aquí y no contra la red: la red se cae, cambia y tarda, y lo que hay
 * que asegurar es la transformación, que es nuestra.
 */

test('las palabras vuelven a su sitio, en orden', () => {
  const indice = { Este: [0], es: [1], un: [2], resumen: [3] };
  assert.equal(resumenDelIndice(indice), 'Este es un resumen');
});

test('una palabra repetida ocupa todas sus posiciones', () => {
  // «la validez de la escala»: «la» aparece dos veces, y las dos cuentan.
  const indice = { la: [0, 3], validez: [1], de: [2], escala: [4] };
  assert.equal(resumenDelIndice(indice), 'la validez de la escala');
});

test('las posiciones no vienen ordenadas, y da igual', () => {
  const indice = { mundo: [1], Hola: [0] };
  assert.equal(resumenDelIndice(indice), 'Hola mundo');
});

test('un hueco en las posiciones no deja un espacio doble', () => {
  // Pasa de verdad: OpenAlex omite alguna posición en resúmenes recortados.
  const indice = { uno: [0], tres: [2] };
  assert.equal(resumenDelIndice(indice), 'uno tres');
});

test('sin resumen se devuelve null, no una cadena vacía', () => {
  // El null es lo que hace que la ficha diga «(sin resumen)» en vez de enseñar
  // una línea en blanco que parece un fallo.
  assert.equal(resumenDelIndice(null), null);
  assert.equal(resumenDelIndice(undefined), null);
  assert.equal(resumenDelIndice({}), null);
  assert.equal(resumenDelIndice('esto no es un índice'), null);
});
