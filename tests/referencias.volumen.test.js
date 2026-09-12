'use strict';

/**
 * Volumen, número y páginas: lo que le faltaba a la bibliografía.
 *
 * Una entrada de referencias salía así:
 *
 *   Hernández, R. (2024). Título. Revista de Educación. https://doi.org/…
 *
 * y APA 7 la pide así:
 *
 *   Hernández, R. (2024). Título. Revista de Educación, 15(2), 45-62. https://…
 *
 * No era un fallo de formato. Los tres campos no existían en la tabla y ninguna
 * de las cuatro vías de entrada los leía, aunque Zotero y los exports de Scopus,
 * Web of Science y PubMed los traen todos. Es de lo primero que mira un asesor
 * en la lista de referencias, así que estas pruebas cubren las dos mitades: que
 * los datos entren por donde entren, y que salgan bien escritos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { leer } = require('../src/modules/references/scopus.parser');
const mapper = require('../src/modules/references/zotero.mapper');
const { entradaDeBibliografia } = require('../src/modules/projects/project.citas');

const buffer = (texto) => Buffer.from(texto, 'utf8');
const primera = (texto) => leer(buffer(texto)).filas[0];

// ── Cómo sale escrito ───────────────────────────────────────────────────────

test('la entrada de referencias sale como la pide APA', () => {
  const entrada = entradaDeBibliografia({
    authors: 'Hernández, R.; Fernández, C.',
    year: 2024,
    title: 'Clima organizacional y desempeño',
    source: 'Revista de Educación',
    volume: '15',
    issue: '2',
    pages: '45-62',
    doi: '10.1234/re.2024.001',
  });

  assert.equal(
    entrada,
    'Hernández, R.; Fernández, C. (2024). Clima organizacional y desempeño. ' +
      'Revista de Educación, 15(2), 45-62. https://doi.org/10.1234/re.2024.001',
  );
});

test('el número va pegado al volumen, y sin número no se deja el paréntesis vacío', () => {
  const base = { authors: 'Gómez, A.', year: 2023, title: 'Estudio', source: 'Educación Superior' };

  assert.match(entradaDeBibliografia({ ...base, volume: '8', pages: '112-130' }), /Superior, 8, 112-130\./);
  assert.match(
    entradaDeBibliografia({ ...base, volume: '8', issue: '3', pages: '112-130' }),
    /Superior, 8\(3\), 112-130\./,
  );
});

test('lo importado antes de que existieran las columnas se sigue leyendo bien', () => {
  // Miles de fuentes ya guardadas no tienen ninguno de los tres, y no pueden
  // salir con comas sueltas ni con un «undefined» en medio.
  const entrada = entradaDeBibliografia({
    authors: 'Vargas, L.',
    year: 2021,
    title: 'Una fuente vieja',
    source: 'Revista Vieja',
    doi: '10.9/y',
  });

  assert.equal(entrada, 'Vargas, L. (2021). Una fuente vieja. Revista Vieja. https://doi.org/10.9/y');
  assert.ok(!/undefined|null|,\s*\./.test(entrada));
});

test('un artículo electrónico pone su número de artículo donde irían las páginas', () => {
  const entrada = entradaDeBibliografia({
    authors: 'Ruiz, P.',
    year: 2022,
    title: 'Artículo electrónico',
    source: 'PLOS ONE',
    volume: '17',
    issue: '3',
    pages: 'e0264812',
    doi: '10.1371/journal.pone.0264812',
  });

  assert.match(entrada, /PLOS ONE, 17\(3\), e0264812\./);
});

// ── Por dónde entran ────────────────────────────────────────────────────────

test('el RIS los trae en VL, IS, SP y EP', () => {
  const fila = primera(
    [
      'TY  - JOUR',
      'TI  - Construct validity revisited',
      'AU  - Hernández, R.',
      'PY  - 2021',
      'JO  - Journal of Testing',
      'VL  - 12',
      'IS  - 3',
      'SP  - 45',
      'EP  - 67',
      'DO  - 10.1000/abc',
      'ER  - ',
    ].join('\n'),
  );

  assert.equal(fila.volume, '12');
  assert.equal(fila.issue, '3');
  assert.equal(fila.pages, '45-67', 'las dos puntas se unen en un rango');
});

test('en BibTeX el número se llama «number», y las páginas llevan doble guion', () => {
  const fila = primera(
    [
      '@article{smith2021,',
      '  title = {Construct validity revisited},',
      '  author = {Hernández, R.},',
      '  journal = {Journal of Testing},',
      '  year = {2021},',
      '  volume = {12},',
      '  number = {3},',
      '  pages = {45--67},',
      '  doi = {10.1000/abc}',
      '}',
    ].join('\n'),
  );

  assert.equal(fila.volume, '12');
  assert.equal(fila.issue, '3', 'en BibTeX el número de la revista es «number»');
  assert.equal(fila.pages, '45-67', 'el doble guion de BibTeX se normaliza a uno');
});

test('el «Plain text file» de Web of Science los trae en VL, IS, BP y EP', () => {
  const fila = primera(
    [
      'PT J',
      'AU Hernandez, R',
      'TI Construct validity revisited',
      'SO JOURNAL OF TESTING',
      'PY 2021',
      'VL 12',
      'IS 3',
      'BP 45',
      'EP 67',
      'DI 10.1000/abc',
      'ER',
      '',
      'EF',
    ].join('\n'),
  );

  assert.equal(fila.volume, '12');
  assert.equal(fila.issue, '3');
  assert.equal(fila.pages, '45-67');
});

test('PubMed los nombra VI, IP y PG', () => {
  const fila = primera(
    [
      'PMID- 12345678',
      'TI  - Construct validity revisited',
      'FAU - Hernandez, Roberto',
      'DP  - 2021',
      'JT  - Journal of Testing',
      'VI  - 12',
      'IP  - 3',
      'PG  - 45-67',
      'AID - 10.1000/abc [doi]',
    ].join('\n'),
  );

  assert.equal(fila.volume, '12');
  assert.equal(fila.issue, '3');
  assert.equal(fila.pages, '45-67');
});

test('el «Plain text» de Scopus los lleva dentro de la línea de la revista', () => {
  // «(2021) Journal of Testing, 12 (3), pp. 45-67. Cited 3 times.» — hasta hoy
  // de esa línea solo se rescataba el nombre de la revista.
  const { filas } = leer(
    buffer(
      [
        'Hernández, R.; Fernández, C.',
        'Construct validity revisited',
        '(2021) Journal of Testing, 12 (3), pp. 45-67. Cited 3 times.',
        'DOI: 10.1000/abc',
        'SOURCE: Scopus',
        '',
        'Gómez, A.',
        'Un electrónico sin páginas',
        '(2019) Otra Revista, art. no. 5.',
        'DOI: 10.1000/xyz',
        'SOURCE: Scopus',
      ].join('\n'),
    ),
  );

  assert.equal(filas[0].source, 'Journal of Testing', 'la revista sigue saliendo limpia');
  assert.equal(filas[0].volume, '12');
  assert.equal(filas[0].issue, '3');
  assert.equal(filas[0].pages, '45-67');

  assert.equal(
    filas[1].pages,
    '5',
    'sin páginas, el número de artículo ocupa su sitio en la referencia',
  );
});

test('un ítem de Zotero los trae en su ficha', () => {
  const { fila } = mapper.aFila({
    key: 'ABCD1234',
    version: 7,
    data: {
      key: 'ABCD1234',
      itemType: 'journalArticle',
      title: 'Clima organizacional',
      creators: [{ creatorType: 'author', lastName: 'Hernández', firstName: 'Roberto' }],
      date: '2024-03-15',
      publicationTitle: 'Revista de Educación',
      volume: '15',
      issue: '2',
      pages: '45-62',
      DOI: '10.1234/re.2024.001',
    },
  });

  assert.equal(fila.volume, '15');
  assert.equal(fila.issue, '2');
  assert.equal(fila.pages, '45-62');
});
