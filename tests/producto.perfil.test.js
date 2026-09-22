'use strict';

/**
 * El perfil de cada producto: el único sitio donde se decide si algo es tesis,
 * artículo o informe. Lo que ya existía tiene que seguir cayendo donde caía.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { perfilDe, traeHerramientas } = require('../src/modules/productos/producto.perfil');

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

/**
 * Las herramientas del panel —Scopus, Zotero, Mendeley, R y el cualitativo—
 * son de quien está investigando. Quien compra SOLO el Humanizador académico
 * trae un texto ya escrito, y no debe ver ni poder usar ninguna.
 */
test('el Humanizador suelto no trae las herramientas del panel', () => {
  for (const codigo of ['HUMANIZADOR_ACADEMICO', 'HUMANIZADOR', 'humanizador_academico', 'HUMANIZAR_TEXTO']) {
    assert.equal(traeHerramientas(codigo), false, codigo);
  }
});

test('los métodos de investigación sí las traen, incluido el que humaniza dentro', () => {
  for (const codigo of [
    'METODO_9_SKILLS',
    'METODO_DE_TESIS_HUMANIZADOR',
    'ARTICULO_SCIENTIFICOS',
    'INFORME_ESTUDIANTIL',
  ]) {
    assert.equal(traeHerramientas(codigo), true, codigo);
  }
});

test('un producto nuevo trae las herramientas mientras no diga lo contrario', () => {
  for (const codigo of [null, undefined, '', 'LO_QUE_VENGA']) {
    assert.equal(traeHerramientas(codigo), true, String(codigo));
  }
});

test('quitar las herramientas no le cambia el perfil: lo que humaniza es una tesis', () => {
  assert.equal(perfilDe('HUMANIZADOR_ACADEMICO').tipo, 'tesis');
});

/**
 * El mapeo bibliométrico es de la ruta del artículo y solo de ella. Es una
 * decisión de producto: en una tesis, el botón invitaba a montar un análisis de
 * un campo entero que no cabe en su capítulo de Antecedentes.
 */
test('solo el artículo trae el mapeo bibliométrico', () => {
  assert.equal(perfilDe('ARTICULO_SCIENTIFICOS').mapeoBibliometrico, true);
  assert.equal(perfilDe('METODO_DE_TESIS_HUMANIZADOR').mapeoBibliometrico, false);
  assert.equal(perfilDe('METODO_9_SKILLS').mapeoBibliometrico, false);
  assert.equal(perfilDe('INFORME_ESTUDIANTIL').mapeoBibliometrico, false);
  // Un producto nuevo no lo trae mientras no se diga: cae en tesis.
  assert.equal(perfilDe('LO_QUE_VENGA').mapeoBibliometrico, false);
});
