'use strict';

/**
 * Videos y guías separados por producto: uno puede estar en varios, y sin
 * ninguno sale en todos (lo publicado antes de separar no se toca).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { aLista, aTexto, productosSchema, deAcceso, deLoComprado } = require('../src/shared/utils/productosDeAyuda');
const { tutorialBodySchema, tutorialPatchSchema } = require('../src/modules/tutorials/tutorial.schema');
const { guiaBodySchema, guiaPatchSchema } = require('../src/modules/guias/guia.schema');

test('de la base sale una lista, y lo que no se conoce se cae', () => {
  assert.deepEqual(aLista('tesis,tsp'), ['tesis', 'tsp']);
  assert.deepEqual(aLista(''), []);
  assert.deepEqual(aLista(null), []);
  assert.deepEqual(aLista('tesis, inventado ,informe'), ['tesis', 'informe']);
});

test('a la base va sin repetidos y siempre en el mismo orden', () => {
  assert.equal(aTexto(['tsp', 'tesis', 'tsp']), 'tesis,tsp');
  assert.equal(aTexto([]), '');
});

test('un video puede estar en dos productos', () => {
  const video = tutorialBodySchema.parse({ orden: 1, titulo: 'Marco teórico', productos: ['tsp', 'tesis'] });
  assert.equal(video.productos, 'tesis,tsp');
});

test('sin productos queda vacío: sale en todos', () => {
  assert.equal(tutorialBodySchema.parse({ orden: 1, titulo: 'Conectar Claude' }).productos, '');
  assert.equal(guiaBodySchema.parse({ titulo: 'Guía de instalación' }).productos, '');
});

test('la ficha de una guía viaja en la query: los productos llegan con comas', () => {
  assert.equal(guiaBodySchema.parse({ titulo: 'Guía del informe', productos: 'informe,tsp' }).productos, 'tsp,informe');
  assert.equal(guiaBodySchema.parse({ titulo: 'Guía del informe', productos: '' }).productos, '');
});

test('un producto que no existe se rechaza', () => {
  assert.equal(productosSchema.safeParse(['tesis', 'cocina']).success, false);
  assert.equal(guiaBodySchema.safeParse({ titulo: 'Guía rara', productos: 'cocina' }).success, false);
});

test('al editar otra cosa, los productos no se tocan', () => {
  assert.equal('productos' in tutorialPatchSchema.parse({ titulo: 'Otro título' }), false);
  assert.equal('productos' in guiaPatchSchema.parse({ active: false }), false);
  assert.equal(guiaPatchSchema.parse({ productos: [] }).productos, '');
});

test('cada acceso da su ruta y el Humanizador, que viene con todas', () => {
  assert.deepEqual(deAcceso('METODO_DE_TESIS_HUMANIZADOR'), ['tesis', 'humanizador']);
  assert.deepEqual(deAcceso('INFORME_ESTUDIANTIL'), ['informe', 'humanizador']);
  assert.deepEqual(deAcceso('TSP_SUFICIENCIA'), ['tsp', 'humanizador']);
  assert.deepEqual(deAcceso('ARTICULO_SCIENTIFICOS'), ['articulo', 'humanizador']);
  assert.deepEqual(deAcceso('ARTICULO_REVIEW'), ['revision', 'humanizador']);
});

test('quien compró solo el Humanizador no ve los videos de ninguna ruta', () => {
  assert.deepEqual(deAcceso('HUMANIZADOR_ACADEMICO'), ['humanizador']);
});

test('lo comprado se junta sin repetir, y sin compras queda vacío', () => {
  assert.deepEqual(deLoComprado({ accesos: ['TSP_1', 'INFORME_ESTUDIANTIL'] }), ['tsp', 'informe', 'humanizador']);
  assert.deepEqual(deLoComprado({ palabras: true, documentos: true }), ['humanizador', 'edicion']);
  assert.deepEqual(deLoComprado({}), []);
});
