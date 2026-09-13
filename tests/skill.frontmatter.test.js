'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { leerFrontmatter } = require('../src/modules/skills/skill.bundle');

/**
 * La cabecera del SKILL.md, de donde sale la descripción que se sugiere para el
 * catálogo.
 *
 * El humanizador la escribe en YAML de bloque —`description: |` y el texto en
 * las líneas de abajo— y el catálogo enseñaba «| Humaniza textos académicos…»,
 * con la barra delante, a quien lista los capítulos del conector.
 */

test('una descripción en bloque con | no arrastra la barra', () => {
  const campos = leerFrontmatter(
    '---\nname: humanizador-academico\ndescription: |\n  Humaniza textos académicos\n  en español.\nlicense: MIT\n---\n\n# Humanizador\n',
  );
  assert.equal(campos.name, 'humanizador-academico');
  assert.equal(campos.description, 'Humaniza textos académicos en español.');
  assert.equal(campos.license, 'MIT');
});

test('también con > y con los modificadores de YAML', () => {
  for (const marca of ['>', '|-', '>+']) {
    const campos = leerFrontmatter(`---\nname: x\ndescription: ${marca}\n  Texto.\n---\n`);
    assert.equal(campos.description, 'Texto.', marca);
  }
});

test('una descripción en una línea sigue igual, con sus dos puntos y sus comillas', () => {
  const campos = leerFrontmatter(
    '---\nname: bajar-similitud\ndescription: Baja el porcentaje: parte del "informe" de Turnitin.\n---\n',
  );
  assert.equal(campos.description, 'Baja el porcentaje: parte del "informe" de Turnitin.');
});

test('una barra dentro del texto no se toca', () => {
  const campos = leerFrontmatter('---\nname: x\ndescription: Tesis | artículo\n---\n');
  assert.equal(campos.description, 'Tesis | artículo');
});
