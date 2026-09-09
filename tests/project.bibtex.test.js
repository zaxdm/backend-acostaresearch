'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bibtex = require('../src/modules/projects/project.bibtex');

const fuente = (extra = {}) => ({
  ref: 'AR97D22F86',
  itemType: 'journalArticle',
  title: 'Construct validity revisited',
  authors: 'Hernández, R.; Fernández, C.',
  year: 2021,
  source: 'Journal of Testing',
  doi: '10.1000/abc',
  url: 'https://ejemplo.com/1',
  abstract: 'Un resumen.',
  tags: 'validity, testing',
  ...extra,
});

test('la clave de la entrada es la misma que va entre corchetes en el texto', () => {
  const salida = bibtex.entrada(fuente());

  // Es lo que hace que pasar de Word a LaTeX sea un buscar-y-reemplazar:
  // [AR97D22F86] en el capítulo, \cite{AR97D22F86} en el .tex.
  assert.match(salida, /^@article\{AR97D22F86,/);
});

test('los autores se separan con «and», no con punto y coma', () => {
  const salida = bibtex.entrada(fuente());

  assert.match(salida, /author = \{Hernández, R\. and Fernández, C\.\}/);
});

test('el título va entre dos llaves, para que no se le baje la capitalización', () => {
  const salida = bibtex.entrada(fuente());

  assert.match(salida, /title = \{\{Construct validity revisited\}\}/);
});

test('los tipos', async (t) => {
  await t.test('reconoce los de Zotero', () => {
    assert.equal(bibtex.tipoDeEntrada('journalArticle'), 'article');
    assert.equal(bibtex.tipoDeEntrada('bookSection'), 'incollection');
  });

  await t.test('y los del export de Scopus, que se escriben distinto', () => {
    assert.equal(bibtex.tipoDeEntrada('Conference Paper'), 'inproceedings');
    assert.equal(bibtex.tipoDeEntrada('Article'), 'article');
    assert.equal(bibtex.tipoDeEntrada('Book Chapter'), 'incollection');
  });

  await t.test('un tipo desconocido no se pierde: cae en misc', () => {
    assert.equal(bibtex.tipoDeEntrada('Cualquier Cosa'), 'misc');
    assert.equal(bibtex.tipoDeEntrada(undefined), 'misc');
  });
});

test('la fuente va al campo que espera cada tipo', async (t) => {
  await t.test('un artículo la lleva en journal', () => {
    assert.match(bibtex.entrada(fuente()), /journal = \{Journal of Testing\}/);
  });

  await t.test('una ponencia, en booktitle', () => {
    const salida = bibtex.entrada(fuente({ itemType: 'Conference Paper', source: 'SIGCSE 2026' }));

    assert.match(salida, /booktitle = \{SIGCSE 2026\}/);
    assert.doesNotMatch(salida, /journal =/);
  });

  await t.test('un libro, en publisher', () => {
    const salida = bibtex.entrada(fuente({ itemType: 'book', source: 'McGraw-Hill' }));

    assert.match(salida, /publisher = \{McGraw-Hill\}/);
  });
});

test('el escapado de LaTeX', async (t) => {
  await t.test('el ampersand no rompe la compilación', () => {
    assert.equal(bibtex.escapar('Salud & Bienestar'), 'Salud \\& Bienestar');
  });

  await t.test('el guion bajo no se convierte en subíndice', () => {
    assert.equal(bibtex.escapar('modelo_1'), 'modelo\\_1');
  });

  await t.test('el porcentaje no comenta el resto de la línea', () => {
    assert.equal(bibtex.escapar('un 50% de la muestra'), 'un 50\\% de la muestra');
  });

  await t.test('la barra invertida se escapa una sola vez', () => {
    // Si se sustituyera al final, escaparía las barras que introdujeron las
    // demás sustituciones y saldría un disparate.
    assert.equal(bibtex.escapar('a\\b'), 'a\\textbackslash{}b');
  });

  await t.test('las llaves del texto no se confunden con las del campo', () => {
    assert.equal(bibtex.escapar('el conjunto {a, b}'), 'el conjunto \\{a, b\\}');
  });

  await t.test('las tildes y la ñ se dejan como están: el archivo va en UTF-8', () => {
    assert.equal(bibtex.escapar('Núñez Peña'), 'Núñez Peña');
  });
});

test('con DOI no se repite la URL, que casi todos los estilos imprimen dos veces', () => {
  const salida = bibtex.entrada(fuente());

  assert.match(salida, /doi = \{10\.1000\/abc\}/);
  assert.doesNotMatch(salida, /url =/);
});

test('sin DOI sí se da la URL, que es lo único que queda para localizarla', () => {
  const salida = bibtex.entrada(fuente({ doi: null }));

  assert.match(salida, /url = \{https:\/\/ejemplo\.com\/1\}/);
});

test('los campos vacíos no se escriben', () => {
  const salida = bibtex.entrada(
    fuente({ abstract: null, tags: '', source: null, year: null, doi: null, url: null }),
  );

  assert.doesNotMatch(salida, /abstract|keywords|journal|year/);
  // Pero lo que sí hay sigue estando.
  assert.match(salida, /title = /);
  assert.match(salida, /author = /);
});

test('el archivo entero', async (t) => {
  const dos = [fuente(), fuente({ ref: 'AR11111111', title: 'Otro trabajo' })];

  await t.test('lleva cabecera que explica de dónde salen las claves', () => {
    const archivo = bibtex.armar(dos);

    assert.match(archivo, /Acosta \| IA & Research/);
    assert.match(archivo, /\\cite\{AR97D22F86\}/);
  });

  await t.test('ordena por clave, para que dos descargas seguidas sean idénticas', () => {
    const archivo = bibtex.armar(dos);
    const alReves = bibtex.armar([...dos].reverse());

    assert.equal(archivo, alReves);
    // Se buscan las ENTRADAS y no las claves sueltas: la cabecera menciona una
    // clave de ejemplo, y buscarla a secas la encuentra ahí antes que en su
    // propia entrada.
    const claves = [...archivo.matchAll(/^@\w+\{(AR\w+),/gm)].map((m) => m[1]);
    assert.deepEqual(claves, ['AR11111111', 'AR97D22F86']);
  });

  await t.test('cada fuente aparece una vez', () => {
    const archivo = bibtex.armar(dos);

    assert.equal(archivo.match(/^@/gm).length, 2);
  });
});
