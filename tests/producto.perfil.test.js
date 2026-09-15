'use strict';

/**
 * El perfil de cada producto: el único sitio donde se decide si algo es tesis,
 * artículo o informe. Lo que ya existía tiene que seguir cayendo donde caía.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { perfilDe } = require('../src/modules/productos/producto.perfil');

test('los productos de tesis siguen siendo tesis', () => {
  for (const codigo of ['METODO_9_SKILLS', 'METODO_DE_TESIS_HUMANIZADOR', 'TESISTA']) {
    assert.equal(perfilDe(codigo).tipo, 'tesis', codigo);
    assert.equal(perfilDe(codigo).obra, 'su tesis');
  }
});

test('lo que empieza por ARTICULO es artículo, como antes', () => {
  assert.equal(perfilDe('ARTICULO_SCIENTIFICOS').tipo, 'articulo');
  assert.equal(perfilDe('ARTICULO_SCIENTIFICOS').revision, 'revisar_el_articulo');
});

test('un código desconocido o vacío cae en tesis, como caía', () => {
  for (const codigo of [null, undefined, '', 'HUMANIZAR_TEXTO']) {
    assert.equal(perfilDe(codigo).tipo, 'tesis', String(codigo));
  }
});

test('el informe tiene su perfil y sus secciones aparte, en orden', () => {
  const informe = perfilDe('INFORME_ESTUDIANTIL');
  assert.equal(informe.tipo, 'informe');
  assert.equal(informe.obra, 'su informe');
  assert.equal(informe.revision, 'revisar_el_informe');
  assert.deepEqual(
    informe.seccionesAparte.map((s) => s.clave),
    ['informe-resumen', 'informe-introduccion'],
  );
});

test('solo el informe tiene secciones aparte', () => {
  assert.equal(perfilDe('METODO_DE_TESIS_HUMANIZADOR').seccionesAparte.length, 0);
  assert.equal(perfilDe('ARTICULO_SCIENTIFICOS').seccionesAparte.length, 0);
});

test('los perfiles no se pueden modificar por accidente', () => {
  assert.ok(Object.isFrozen(perfilDe('INFORME_ESTUDIANTIL')));
  assert.ok(Object.isFrozen(perfilDe('INFORME_ESTUDIANTIL').seccionesAparte));
});
