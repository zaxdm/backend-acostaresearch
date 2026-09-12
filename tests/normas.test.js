'use strict';

/**
 * Las quince normas de citas y sus archivos.
 *
 * Lo que se prueba es lo que rompería el Word sin avisar: un archivo que falta,
 * un estilo que dependa de otro que no tenemos, o una familia mal apuntada. La
 * familia decide si la cita va en el texto o en una nota al pie, así que una
 * norma de notas marcada como autor-fecha sacaría un documento entero mal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const normas = require('../src/modules/projects/project.normas');

const FAMILIA_DE_CSL = {
  'author-date': 'autor-fecha',
  author: 'autor-fecha',
  numeric: 'numerica',
  note: 'notas',
};

test('son las quince de Zotero, sin repetir, y APA es la de por defecto', () => {
  assert.equal(normas.NORMAS.length, 15);
  assert.equal(new Set(normas.IDS_DE_NORMA).size, 15);
  assert.equal(normas.NORMA_POR_DEFECTO, 'apa');
  assert.equal(normas.NORMAS[0].id, 'apa', 'la primera que se enseña es la que usa casi todo el mundo');
});

test('cada norma tiene su archivo, no depende de otro y su familia es la del archivo', () => {
  for (const norma of normas.NORMAS) {
    const xml = normas.leerEstilo(norma.id);
    assert.ok(!xml.includes('independent-parent'), `${norma.id} depende de otro estilo`);

    const formato = (xml.match(/citation-format="([a-z-]+)"/) || [])[1];
    assert.equal(norma.familia, FAMILIA_DE_CSL[formato], `familia de ${norma.id}`);
  }
});

test('los cuatro idiomas tienen su archivo, y el de por defecto es español', () => {
  assert.equal(normas.IDIOMA_POR_DEFECTO, 'es-ES');
  for (const idioma of normas.IDIOMAS) {
    const xml = normas.leerIdioma(idioma.id);
    assert.ok(xml && xml.includes(`xml:lang="${idioma.id}"`), idioma.id);
  }
});

test('una norma o un idioma que no existen caen en los de por defecto', () => {
  assert.equal(normas.normaDe('inventada').id, 'apa');
  assert.equal(normas.normaDe(null).id, 'apa');
  assert.equal(normas.idiomaDe('xx-XX').id, 'es-ES');
});

test('un idioma sin archivo devuelve false, que es lo que espera citeproc', () => {
  assert.equal(normas.leerIdioma('es-PE'), false);
});
