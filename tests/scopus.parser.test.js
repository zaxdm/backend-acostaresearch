'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { leer, leerCsv } = require('../src/modules/references/scopus.parser');

const buffer = (texto) => Buffer.from(texto, 'utf8');

test('el lector de CSV respeta las comillas y los saltos de línea', async (t) => {
  await t.test('un resumen con comas dentro no desplaza las columnas', () => {
    const filas = leerCsv('Authors,Title,Year\n"Smith, J.","Validity, reliability and rigor",2021');

    assert.deepEqual(filas[1], ['Smith, J.', 'Validity, reliability and rigor', '2021']);
  });

  await t.test('un resumen partido en varias líneas sigue siendo un solo campo', () => {
    const filas = leerCsv('Title,Abstract\n"Un título","Primera línea.\nSegunda línea."');

    assert.equal(filas.length, 2);
    assert.equal(filas[1][1], 'Primera línea.\nSegunda línea.');
  });

  await t.test('dos comillas seguidas son una comilla literal', () => {
    const filas = leerCsv('Title\n"El concepto de ""validez"" en Messick"');

    assert.equal(filas[1][0], 'El concepto de "validez" en Messick');
  });

  await t.test('los finales de línea de Windows no dejan un retorno pegado', () => {
    const filas = leerCsv('Title,Year\r\nUn título,2021\r\n');

    assert.deepEqual(filas[1], ['Un título', '2021']);
  });
});

test('un CSV de Scopus se convierte en fichas', async (t) => {
  const CSV = [
    'Authors,Title,Year,Source title,DOI,Link,Abstract,Author Keywords,EID,Document Type',
    '"Hernández R., Fernández C.","Construct validity revisited",2021,"Journal of Testing",' +
      '10.1000/abc,https://ej.com/1,"Un resumen, con coma.","validity; testing",' +
      '2-s2.0-85012345678,Article',
  ].join('\n');

  await t.test('los campos aterrizan donde tienen que aterrizar', () => {
    const { filas, formato } = leer(buffer(CSV));

    assert.equal(formato, 'csv');
    assert.equal(filas.length, 1);
    assert.equal(filas[0].title, 'Construct validity revisited');
    assert.equal(filas[0].year, 2021);
    assert.equal(filas[0].source, 'Journal of Testing');
    assert.equal(filas[0].doi, '10.1000/abc');
    assert.equal(filas[0].abstract, 'Un resumen, con coma.');
  });

  await t.test('los autores salen en formato de cita', () => {
    const { filas } = leer(buffer(CSV));

    assert.equal(filas[0].authors, 'Hernández, R.; Fernández, C.');
  });

  await t.test('nace sin nota: la nota es de Acosta y esto no lo escribió Acosta', () => {
    const { filas } = leer(buffer(CSV));

    assert.equal(filas[0].notes, null);
    assert.equal(filas[0].origin, 'SCOPUS');
    assert.equal(filas[0].zoteroKey, null);
  });

  await t.test('la búsqueda va normalizada, para que «validez» encuentre «Validez»', () => {
    const { filas } = leer(buffer(CSV));

    assert.match(filas[0].busqueda, /hernandez/);
    assert.ok(!/[A-Z]/.test(filas[0].busqueda));
  });

  await t.test('el orden de las columnas no importa: se buscan por nombre', () => {
    const alReves = ['Year,Title,DOI', '2019,"Otro título",10.1000/xyz'].join('\n');
    const { filas } = leer(buffer(alReves));

    assert.equal(filas[0].title, 'Otro título');
    assert.equal(filas[0].year, 2019);
    assert.equal(filas[0].doi, '10.1000/xyz');
  });
});

test('la identidad de una fuente', async (t) => {
  await t.test('manda el DOI, que es universal', () => {
    const { filas } = leer(buffer('Title,DOI,EID\n"Un título",10.1000/ABC,2-s2.0-1'));

    assert.equal(filas[0].sourceRef, 'doi:10.1000/abc');
  });

  await t.test('sin DOI vale el EID de Scopus', () => {
    const { filas } = leer(buffer('Title,DOI,EID\n"Un título",,2-s2.0-85012345678'));

    assert.equal(filas[0].sourceRef, 'eid:2-s2.0-85012345678');
  });

  await t.test('sin ninguno de los dos, el título normalizado', () => {
    const { filas } = leer(buffer('Title,DOI\n"Validez de constructo",'));

    assert.equal(filas[0].sourceRef, 'titulo:validezdeconstructo');
  });

  await t.test('el mismo DOI dos veces en el archivo se guarda una sola vez', () => {
    const repetido = [
      'Title,DOI',
      '"Un título",10.1000/abc',
      '"El mismo con otro título",10.1000/ABC',
    ].join('\n');

    const { filas, leidas } = leer(buffer(repetido));

    assert.equal(leidas, 2);
    assert.equal(filas.length, 1);
  });

  await t.test('un DOI escrito como enlace es el mismo DOI', () => {
    const { filas } = leer(buffer('Title,DOI\n"Un título",https://doi.org/10.1000/abc'));

    assert.equal(filas[0].doi, '10.1000/abc');
    assert.equal(filas[0].sourceRef, 'doi:10.1000/abc');
  });
});

test('una fila sin título no se guarda: no se puede citar ni encontrar', () => {
  const { filas, descartadas } = leer(buffer('Title,Year\n,2021\n"Un título",2020'));

  assert.equal(filas.length, 1);
  assert.equal(descartadas, 1);
});

test('RIS', async (t) => {
  const RIS = [
    'TY  - JOUR',
    'TI  - Construct validity revisited',
    'AU  - Hernández, R.',
    'AU  - Fernández, C.',
    'PY  - 2021',
    'JO  - Journal of Testing',
    'DO  - 10.1000/abc',
    'AB  - Un resumen que sigue',
    '      en la línea de abajo.',
    'KW  - validity',
    'ER  - ',
  ].join('\n');

  await t.test('se reconoce por su contenido, no por la extensión', () => {
    assert.equal(leer(buffer(RIS)).formato, 'ris');
  });

  await t.test('los autores repetidos se juntan en una sola cita', () => {
    const { filas } = leer(buffer(RIS));

    assert.equal(filas[0].authors, 'Hernández, R.; Fernández, C.');
  });

  await t.test('un resumen partido en varias líneas se recompone', () => {
    const { filas } = leer(buffer(RIS));

    assert.equal(filas[0].abstract, 'Un resumen que sigue en la línea de abajo.');
  });
});

test('BibTeX', async (t) => {
  const BIB = [
    '@article{smith2021,',
    '  author = {Smith, John and Doe, Jane},',
    '  title = {Construct validity revisited},',
    '  journal = {Journal of Testing},',
    '  year = {2021},',
    '  doi = {10.1000/abc},',
    '  abstract = {Un resumen con {llaves} dentro.}',
    '}',
  ].join('\n');

  await t.test('se reconoce por su contenido', () => {
    assert.equal(leer(buffer(BIB)).formato, 'bibtex');
  });

  await t.test('el «and» de BibTeX se traduce al separador de la casa', () => {
    const { filas } = leer(buffer(BIB));

    assert.equal(filas[0].authors, 'Smith, John; Doe, Jane');
  });

  await t.test('las llaves anidadas no cortan el campo antes de tiempo', () => {
    const { filas } = leer(buffer(BIB));

    assert.equal(filas[0].abstract, 'Un resumen con llaves dentro.');
    assert.equal(filas[0].title, 'Construct validity revisited');
  });
});

test('un archivo que no es un export devuelve cero fuentes, no basura', () => {
  const { filas } = leer(buffer('esto no es un csv ni nada parecido\nsolo texto suelto'));

  assert.equal(filas.length, 0);
});
