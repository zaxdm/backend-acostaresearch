'use strict';

/**
 * Las citas en la norma del proyecto, con el motor de Zotero.
 *
 * Contra citeproc y los archivos de estilo de verdad, sin sustituir nada: lo
 * que importa es lo que sale, y eso solo se ve ejecutándolo. Cubre lo que un
 * jurado mira primero en cada familia de normas: el paréntesis de APA, la
 * numeración por orden de aparición de IEEE y las notas de Chicago.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const csl = require('../src/modules/projects/project.csl');
const normas = require('../src/modules/projects/project.normas');

const WARSHAW = {
  ref: 'AR11111111',
  itemType: 'journalArticle',
  title: 'Disentangling behavioral intention and behavioral expectation',
  authors: 'Warshaw, P. R.; Davis, F. D.',
  year: 1985,
  source: 'Journal of Experimental Social Psychology',
  volume: '21',
  issue: '3',
  pages: '213-228',
  doi: '10.1016/0022-1031(85)90017-4',
};

const BRAUN = {
  ref: 'AR22222222',
  itemType: 'journalArticle',
  title: 'Using thematic analysis in psychology',
  authors: 'Braun, V.; Clarke, V.',
  year: 2006,
  source: 'Qualitative Research in Psychology',
  volume: '3',
  issue: '2',
  pages: '77-101',
  doi: '10.1191/1478088706qp063oa',
};

const LIBRO = {
  ref: 'AR33333333',
  itemType: 'book',
  title: 'Metodología de la investigación',
  authors: 'Hernández Sampieri, R.; Mendoza Torres, C. P.',
  year: 2018,
  source: 'McGraw-Hill',
};

const porClave = new Map([WARSHAW, BRAUN, LIBRO].map((f) => [f.ref, f]));

const aplicar = (norma, texto, extra = {}) =>
  csl.renderizar({ norma, idioma: 'es-ES', porClave, capitulos: [{ texto }], ...extra });

const texto = (tramos) => (tramos ?? []).map((t) => t.texto).join('');
const cita = (r, n) => texto(r.citas.get(n).tramos);

// ── APA ─────────────────────────────────────────────────────────────────────

test('APA: la cita va entre paréntesis y el texto queda con su hueco', () => {
  const r = aplicar('apa', 'Primero [AR11111111]. Después [AR22222222].');

  assert.equal(cita(r, 1), '(Warshaw & Davis, 1985)');
  assert.equal(cita(r, 2), '(Braun & Clarke, 2006)');
  assert.equal(r.textos[0], 'Primero ⟦C1⟧. Después ⟦C2⟧.');
});

test('APA: la bibliografía va en orden alfabético, con la revista en cursiva', () => {
  const r = aplicar('apa', 'Primero [AR11111111]. Después [AR22222222].');
  const primera = r.bibliografia.entradas[0];

  assert.equal(r.bibliografia.titulo, 'Referencias');
  assert.equal(r.bibliografia.sangriaFrancesa, true);
  assert.match(texto(primera.tramos), /^Braun, V\., & Clarke, V\. \(2006\)/);
  assert.ok(primera.tramos.some((t) => t.cursiva && t.texto.includes('Qualitative Research in Psychology')));
});

test('dos marcas seguidas son una sola cita con las dos fuentes', () => {
  const r = aplicar('apa', 'Se ha estudiado [AR11111111][AR22222222].');

  assert.equal(r.citas.size, 1);
  assert.equal(cita(r, 1), '(Braun & Clarke, 2006; Warshaw & Davis, 1985)');
});

test('narrativa en APA: los autores en la frase, con «y», y el año entre paréntesis', () => {
  const r = aplicar('apa', '[AR22222222:n] proponen seis fases.');
  const c = r.citas.get(1);

  assert.equal(texto(c.antes), 'Braun y Clarke ');
  assert.equal(cita(r, 1), '(2006)');
});

test('la página se pone donde la pide la norma', () => {
  const r = aplicar('apa', 'Lo dicen así [AR22222222:p. 79].');
  assert.match(cita(r, 1), /2006, p\. 79\)$/);
});

// ── Numéricas ───────────────────────────────────────────────────────────────

test('IEEE numera por orden de aparición, y repetir una fuente repite su número', () => {
  const r = aplicar('ieee', 'Uno [AR22222222]. Dos [AR11111111]. Otra vez [AR22222222].');

  assert.equal(cita(r, 1), '[1]');
  assert.equal(cita(r, 2), '[2]');
  assert.equal(cita(r, 3), '[1]');
});

test('IEEE: la bibliografía va por número, con la etiqueta aparte para alinearla', () => {
  const r = aplicar('ieee', 'Uno [AR22222222]. Dos [AR11111111].');

  assert.equal(r.bibliografia.etiquetaAlineada, true);
  assert.equal(texto(r.bibliografia.entradas[0].etiqueta), '[1]');
  assert.match(texto(r.bibliografia.entradas[0].tramos), /Braun/);
  assert.match(texto(r.bibliografia.entradas[1].tramos), /Warshaw/);
});

test('en una numérica la narrativa lleva el nombre y el número', () => {
  const r = aplicar('ieee', '[AR22222222:n] proponen seis fases.');

  assert.equal(texto(r.citas.get(1).antes), 'Braun y Clarke ');
  assert.equal(cita(r, 1), '[1]');
});

// ── Notas ───────────────────────────────────────────────────────────────────

test('Chicago notas: cada cita es una nota numerada, y la segunda sale abreviada', () => {
  const r = aplicar('chicago-notes-bibliography', 'Uno [AR11111111]. Dos [AR11111111].');

  assert.equal(r.citas.get(1).nota, 1);
  assert.equal(r.citas.get(2).nota, 2);
  assert.match(cita(r, 1), /Warshaw/);
  assert.ok(cita(r, 2).length < cita(r, 1).length, 'la segunda vez va la forma corta');
  assert.equal(r.bibliografia.titulo, 'Bibliografía');
});

// ── Lo que no se encuentra ──────────────────────────────────────────────────

test('una clave que no existe se deja a la vista con su aviso', () => {
  const r = aplicar('apa', 'Algo se afirma [ARDEADBEEF].');

  assert.equal(r.citas.size, 0);
  assert.ok(r.textos[0].includes(csl.CITA_PERDIDA));
  assert.deepEqual(r.perdidas, ['ARDEADBEEF']);
  assert.equal(r.bibliografia, null);
});

// ── El formato ──────────────────────────────────────────────────────────────

test('el HTML de citeproc se convierte en tramos con su formato', () => {
  const tramos = csl.comoTramos(
    '<i>Revista</i>, <i>3</i>(2) n.<sup>o</sup> &#38; <span style="font-variant:small-caps;">Sc</span>',
  );

  assert.deepEqual(
    tramos.map((t) => [t.texto, t.cursiva, t.superindice, t.versalitas]),
    [
      ['Revista', true, false, false],
      [', ', false, false, false],
      ['3', true, false, false],
      ['(2) n.', false, false, false],
      ['o', false, true, false],
      [' & ', false, false, false],
      ['Sc', false, false, true],
    ],
  );
});

test('un libro lleva la editorial como editorial, no como revista', () => {
  const item = csl.comoCsl(LIBRO);

  assert.equal(item.type, 'book');
  assert.equal(item.publisher, 'McGraw-Hill');
  assert.equal(item['container-title'], undefined);
});

// ── Las quince ──────────────────────────────────────────────────────────────

test('las quince normas dan citas y bibliografía sin romperse', () => {
  for (const norma of normas.NORMAS) {
    const r = aplicar(norma.id, 'A [AR11111111]. B [AR33333333][AR22222222].');

    assert.equal(r.citas.size, 2, norma.id);
    for (const c of r.citas.values()) assert.ok(cita({ citas: new Map([[1, c]]) }, 1).trim() !== '', norma.id);
    assert.equal(r.bibliografia.entradas.length, 3, norma.id);
    assert.ok(!JSON.stringify(r).includes('NO_PRINTED_FORM'), norma.id);
  }
});

// ── El campo de Zotero ──────────────────────────────────────────────────────

test('el código del campo lleva la ficha, la URI que se le dé y el texto visible', () => {
  const r = aplicar('apa', 'Primero [AR11111111].', {
    urisDe: (fuente) => [`http://zotero.org/users/1/items/${fuente.ref.slice(2)}`],
  });

  const codigo = r.citas.get(1).codigo;
  assert.match(codigo, /^ ADDIN ZOTERO_ITEM CSL_CITATION \{/);

  const datos = JSON.parse(codigo.replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));
  assert.equal(datos.citationItems[0].uris[0], 'http://zotero.org/users/1/items/11111111');
  assert.equal(datos.citationItems[0].itemData.title, WARSHAW.title);
  assert.equal(datos.properties.plainCitation, cita(r, 1), 'Zotero lo compara con lo que se ve');
});

test('sin URI de Zotero, la cita lleva una de Acosta que no se confunde con ningún ítem', () => {
  const r = aplicar('apa', 'Primero [AR11111111].');
  const datos = JSON.parse(r.citas.get(1).codigo.replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));

  assert.equal(datos.citationItems[0].uris[0], 'https://acostaresearch.com/fuentes/AR11111111');
});
