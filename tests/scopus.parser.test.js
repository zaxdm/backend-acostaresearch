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

test('el «Plain text» de Scopus (.txt)', async (t) => {
  const TXT = [
    'Scopus',
    'EXPORT DATE: 10 September 2026',
    '',
    'Hernández R., Fernández C.',
    'AUTHOR FULL NAMES: Hernández, Roberto (57200000000); Fernández, Carlos (57200000001)',
    'Construct validity revisited',
    '(2021) Journal of Testing, Measurement and Evaluation, 12 (3), pp. 45-67. Cited 3 times.',
    'https://www.scopus.com/inward/record.uri?eid=2-s2.0-85012345678&doi=10.1000%2fabc&partnerID=40',
    '',
    'DOI: 10.1000/abc',
    '',
    'ABSTRACT: Un resumen, con coma.',
    'AUTHOR KEYWORDS: validity; testing',
    'DOCUMENT TYPE: Article',
    'PUBLICATION STAGE: Final',
    'SOURCE: Scopus',
    '',
    '[No author name available]',
    'TEACHING: A REVIEW',
    '(2019) Otra Revista, art. no. 5.',
    'SOURCE: Scopus',
  ].join('\n');

  await t.test('se reconoce por su contenido', () => {
    assert.equal(leer(buffer(TXT)).formato, 'scopus txt');
  });

  await t.test('las líneas sueltas se reparten por su forma', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas.length, 2);
    assert.equal(filas[0].title, 'Construct validity revisited');
    assert.equal(filas[0].authors, 'Hernández, R.; Fernández, C.');
    assert.equal(filas[0].year, 2021);
    assert.equal(filas[0].doi, '10.1000/abc');
    assert.equal(filas[0].abstract, 'Un resumen, con coma.');
  });

  await t.test('la revista conserva sus comas y pierde el volumen', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas[0].source, 'Journal of Testing, Measurement and Evaluation');
  });

  await t.test('un título en mayúsculas con dos puntos no se toma por etiqueta', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas[1].title, 'TEACHING: A REVIEW');
    assert.equal(filas[1].authors, '');
    assert.equal(filas[1].source, 'Otra Revista');
  });
});

test('el «Plain text file» de Web of Science (.txt)', async (t) => {
  const TXT = [
    'FN Clarivate Analytics Web of Science',
    'VR 1.0',
    'PT J',
    'AU Hernandez, R',
    '   Fernandez, C',
    'TI Construct validity revisited in a',
    '   second line',
    'SO JOURNAL OF TESTING',
    'DE validity; testing',
    'AB Un resumen.',
    'PY 2021',
    'DI 10.1000/abc',
    'UT WOS:000123456700001',
    'ER',
    '',
    'EF',
  ].join('\n');

  await t.test('se reconoce por su contenido', () => {
    assert.equal(leer(buffer(TXT)).formato, 'wos txt');
  });

  await t.test('la continuación de AU es otro autor; la del título, el mismo título', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas.length, 1);
    assert.equal(filas[0].authors, 'Hernandez, R; Fernandez, C');
    assert.equal(filas[0].title, 'Construct validity revisited in a second line');
  });

  await t.test('el resto de campos aterriza en su sitio', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas[0].year, 2021);
    assert.equal(filas[0].source, 'JOURNAL OF TESTING');
    assert.equal(filas[0].sourceRef, 'doi:10.1000/abc');
  });
});

test('el «Tab-delimited» de Web of Science (.txt)', async (t) => {
  const TSV = [
    'PT\tAU\tTI\tSO\tPY\tDI\tUT',
    'J\tHernandez, R; Fernandez, C\tEl concepto de "validez", revisado\tJOURNAL OF TESTING\t2021\t10.1000/abc\tWOS:1',
  ].join('\r\n');

  await t.test('se reconoce aunque el título lleve comas y comillas', () => {
    const { filas, formato } = leer(buffer(TSV));

    assert.equal(formato, 'wos tsv');
    assert.equal(filas[0].title, 'El concepto de "validez", revisado');
    assert.equal(filas[0].year, 2021);
    assert.equal(filas[0].doi, '10.1000/abc');
  });

  await t.test('en UTF-16, como lo descarga la opción «Win», también', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TSV, 'utf16le')]);
    const { filas } = leer(utf16);

    assert.equal(filas.length, 1);
    assert.equal(filas[0].source, 'JOURNAL OF TESTING');
  });
});

test('el MEDLINE de PubMed (.txt)', async (t) => {
  const TXT = [
    'PMID- 12345678',
    'TI  - Construct validity revisited in a',
    '      second line.',
    'LID - S0000-0000(21)00001-1 [pii]',
    'LID - 10.1000/abc [doi]',
    'AB  - Un resumen.',
    'FAU - Hernández, Roberto',
    'AU  - Hernández R',
    'FAU - Fernández, Carlos',
    'AU  - Fernández C',
    'DP  - 2021 Mar 5',
    'JT  - Journal of testing',
    'OT  - validity',
    'OT  - testing',
    '',
    'PMID- 87654321',
    'TI  - Sin DOI.',
    'AU  - Doe J',
    'DP  - 2019',
  ].join('\n');

  await t.test('se reconoce, y no se confunde con RIS', () => {
    assert.equal(leer(buffer(TXT)).formato, 'pubmed');
  });

  await t.test('el DOI se saca de la variante marcada [doi], no del PII', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas[0].doi, '10.1000/abc');
    assert.equal(filas[0].title, 'Construct validity revisited in a second line.');
  });

  await t.test('los autores salen del nombre completo cuando lo hay', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas[0].authors, 'Hernández, Roberto; Fernández, Carlos');
    assert.equal(filas[0].year, 2021);
    assert.equal(filas[0].source, 'Journal of testing');
  });

  await t.test('sin DOI, la identidad es el PMID', () => {
    const { filas } = leer(buffer(TXT));

    assert.equal(filas[1].sourceRef, 'eid:pmid:87654321');
    // Sin FAU queda el AU corto, llevado al formato de cita de la casa.
    assert.equal(filas[1].authors, 'Doe, J');
  });
});

test('un archivo que no es un export devuelve cero fuentes, no basura', () => {
  const { filas } = leer(buffer('esto no es un csv ni nada parecido\nsolo texto suelto'));

  assert.equal(filas.length, 0);
});
