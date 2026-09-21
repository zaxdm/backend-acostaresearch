'use strict';

/**
 * El exporte de una base bibliográfica, para el mapeo con bibliometrix.
 *
 * Lo que importa: que una matriz de tesis NUNCA se tome por un exporte (se
 * leería con convert2df y el análisis entero se rompería), que cada base se
 * lea con su `dbsource` y su `format`, y que el texto plano de Scopus —que
 * bibliometrix no lee— salga convertido a su CSV sin perder referencias,
 * afiliaciones ni citas.
 *
 * Que bibliometrix lea de verdad el CSV resultante se comprobó con R 4.6.1 y
 * bibliometrix 5.5.0 contra un exporte real de 43 documentos (21-sep-2026), y
 * en el servidor lo comprueba infra/r/probar-jaula.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bibliografia = require('../src/modules/r/r.bibliografia');
const formato = require('../src/modules/r/r.formato');

const bytes = (texto) => Buffer.from(texto, 'utf8');

const SCOPUS_TXT = [
  'Scopus',
  'EXPORT DATE: 05 September 2026',
  '',
  'Duan C., Cheung S.K.S.',
  'AUTHOR FULL NAMES: Duan, Chenggui (57339537900); Cheung, Simon K. S. (7402406661)',
  '57339537900; 7402406661',
  'A Study on the Faculty Adoption of AI-Powered Tools',
  '(2026) Journal of Physics: Conference Series, Education, 11, 2, art. no. 1780142, Cited 3 times.',
  'DOI: 10.1007/978-981-92-3761-6_25',
  'https://www.scopus.com/pages/publications/105046871383?origin=resultslist',
  '',
  'AFFILIATIONS: Hong Kong Metropolitan University, Hong Kong SAR, China',
  'ABSTRACT: The global rise of "Generative AI" is transforming higher education.',
  'AUTHOR KEYWORDS: Artificial Intelligence; Assessment',
  'FUNDING DETAILS: Quality Enhancement Support Scheme (QESS)',
  'FUNDING DETAILS: Hong Kong Education Bureau (EDB), 01/QESS/2024',
  'FUNDING TEXT 1: This work was supported by the QESS.',
  'REFERENCES: Holmes W., Miao F., Guidance for generative AI in education and research, (2023); ',
  'UNESCO: Guidance for generative AI in education, (2023); ',
  'Braun V., Clarke V., Using thematic analysis in psychology, Qual. Res. Psychol, 3, 2, pp. 77-101, (2006)',
  'CORRESPONDENCE ADDRESS: C. Duan; Hong Kong Metropolitan University; email: dduan@hkmu.edu.hk',
  'LANGUAGE OF ORIGINAL DOCUMENT: English',
  'DOCUMENT TYPE: Conference paper',
  'SOURCE: Scopus',
  '',
  '[No author name available]',
  'Editorial: teaching with AI',
  '(2025) Revista de Educación, 4, pp. 10 - 20.',
  'https://www.scopus.com/inward/record.uri?eid=2-s2.0-85100000000&origin=inward',
  '',
  'DOCUMENT TYPE: Editorial',
  'SOURCE: Scopus',
  '',
].join('\n');

/** Un CSV con comillas dobladas y sin saltos dentro de los campos, como el que sale de aquí. */
function leerCsv(texto) {
  const filas = texto
    .trim()
    .split('\n')
    .map((linea) => [...linea.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')));
  const [cabecera, ...resto] = filas;
  return resto.map((fila) => Object.fromEntries(cabecera.map((c, i) => [c, fila[i]])));
}

test('reconoce cada exporte por su contenido', () => {
  assert.equal(bibliografia.detectar(bytes(SCOPUS_TXT)), 'scopus-txt');
  assert.equal(
    bibliografia.detectar(bytes('﻿"Authors","Author full names","Title","Year","Source title","Link","EID"\n"a"\n')),
    'scopus-csv',
  );
  assert.equal(
    bibliografia.detectar(bytes('Scopus\nEXPORT DATE: 1 Jan 2026\n\n@ARTICLE{Duan2026,\nauthor={Duan, C.}\n}')),
    'scopus-bibtex',
  );
  assert.equal(bibliografia.detectar(bytes('@article{x,\n title={a},\n source={Scopus}\n}')), 'scopus-bibtex');
  assert.equal(
    bibliografia.detectar(bytes('@article{ WOS:1,\nAuthor = {Perez, J},\nUnique-ID = {WOS:000000000000001},\n}')),
    'wos-bibtex',
  );
  assert.equal(bibliografia.detectar(fs.readFileSync(path.join(__dirname, 'ayudas', 'muestra-wos.txt'))), 'wos-txt');
  assert.equal(bibliografia.detectar(bytes('PMID- 12345678\nOWN - NLM\nTI  - Un estudio\nAU  - Perez J\n')), 'pubmed');
  assert.equal(bibliografia.detectar(bytes('Lens ID,Title,Date Published\n1,a,2020\n')), 'lens-csv');
  assert.equal(bibliografia.detectar(bytes('@book{mio,\n title={Mi libro}\n}')), 'bibtex-otro');
});

test('una matriz de tesis no se toma nunca por un exporte', () => {
  assert.equal(bibliografia.detectar(bytes('sep=;\r\nid;sexo;p1\r\n1;F;3,5\r\n')), null);
  assert.equal(bibliografia.detectar(bytes('id,Title,Year,Source\n1,a,2020,b\n')), null);
  // Una columna llamada «Source title» sola, sin EID ni Link, no basta.
  assert.equal(bibliografia.detectar(bytes('id,Source title,puntaje\n1,a,3\n')), null);
  assert.equal(bibliografia.detectar(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])), null);
  assert.equal(bibliografia.detectar(Buffer.alloc(0)), null);
});

test('la cita de Scopus se desmonta desde el final: la revista puede llevar comas', () => {
  assert.deepEqual(
    bibliografia.leerCita(
      '(2026) Journal of Physics: Conference Series, Education, 11, 2, art. no. 1780142, Cited 3 times.',
    ),
    {
      Year: '2026',
      'Cited by': '3',
      'Source title': 'Journal of Physics: Conference Series, Education',
      'Art. No.': '1780142',
      Volume: '11',
      Issue: '2',
    },
  );
  assert.deepEqual(bibliografia.leerCita('(2027) Lecture Notes in Computer Science, 16778 LNCS, pp. 354 - 368, Cited 0 times.'), {
    Year: '2027',
    'Cited by': '0',
    'Source title': 'Lecture Notes in Computer Science',
    'Page start': '354',
    'Page end': '368',
    Volume: '16778 LNCS',
  });
});

test('los autores cortos pasan a ir separados por punto y coma', () => {
  assert.equal(bibliografia.autoresCortos('Duan C., Cheung S.K.S.'), 'Duan C.; Cheung S.K.S.');
  assert.equal(
    bibliografia.autoresCortos('Oliveira A.P., Coelho M., Póvoa O.'),
    'Oliveira A.P.; Coelho M.; Póvoa O.',
  );
  assert.equal(bibliografia.autoresCortos('[No author name available]'), '');
});

test('el texto plano de Scopus sale como su CSV, sin perder nada de lo que usa bibliometrix', () => {
  const { csv, documentos, saltados } = bibliografia.scopusTxtACsv(SCOPUS_TXT);
  assert.equal(documentos, 2);
  assert.equal(saltados, 0);

  const [uno, dos] = leerCsv(csv);
  assert.equal(uno.Authors, 'Duan C.; Cheung S.K.S.');
  assert.equal(uno['Author full names'], 'Duan, Chenggui (57339537900); Cheung, Simon K. S. (7402406661)');
  assert.equal(uno['Author(s) ID'], '57339537900; 7402406661');
  assert.equal(uno.Title, 'A Study on the Faculty Adoption of AI-Powered Tools');
  assert.equal(uno.Year, '2026');
  assert.equal(uno['Source title'], 'Journal of Physics: Conference Series, Education');
  assert.equal(uno['Cited by'], '3');
  assert.equal(uno.DOI, '10.1007/978-981-92-3761-6_25');
  assert.equal(uno.EID, '2-s2.0-105046871383');
  assert.equal(uno.Affiliations, 'Hong Kong Metropolitan University, Hong Kong SAR, China');
  assert.equal(uno.Abstract, 'The global rise of "Generative AI" is transforming higher education.');
  assert.equal(uno['Funding Details'], 'Quality Enhancement Support Scheme (QESS); Hong Kong Education Bureau (EDB), 01/QESS/2024');
  assert.equal(uno['Document Type'], 'Conference paper');
  assert.equal(uno.Source, 'Scopus');

  // Las tres referencias, incluida la que empieza por «UNESCO:», que no es una etiqueta.
  const referencias = uno.References.split('; ');
  assert.equal(referencias.length, 3);
  assert.match(referencias[1], /^UNESCO: Guidance/);
  assert.doesNotMatch(uno.References, /;\s*$/);

  assert.equal(dos.Authors, '');
  assert.equal(dos.Title, 'Editorial: teaching with AI');
  assert.equal(dos['Cited by'], '0', 'sin «Cited N times» son cero citas, no un hueco');
  assert.equal(dos['Page start'], '10');
  assert.equal(dos.EID, '2-s2.0-85100000000');
});

test('cada base se lee con su dbsource y su format, y con el nombre de siempre', () => {
  const txt = bibliografia.preparar(bytes(SCOPUS_TXT), 'scopus-txt');
  assert.equal(txt.tipo, 'bibliografia');
  assert.equal(txt.archivo, 'datos.csv');
  assert.equal(
    txt.lectura,
    'datos <- suppressWarnings(bibliometrix::convert2df("datos.csv", dbsource = "scopus", format = "csv"))',
  );
  assert.match(txt.contenido.toString('utf8'), /^"Authors","Author full names"/);
  assert.match(txt.aviso, /texto plano con 2 documentos/);

  const wos = bibliografia.preparar(bytes('FN Clarivate Analytics Web of Science\nVR 1.0\nPT J\n'), 'wos-txt');
  assert.equal(wos.archivo, 'datos.txt');
  assert.match(wos.lectura, /dbsource = "wos", format = "plaintext"/);

  const bib = bibliografia.preparar(bytes('@article{x, source={Scopus}}'), 'scopus-bibtex');
  assert.equal(bib.archivo, 'datos.bib');
  assert.match(bib.lectura, /dbsource = "scopus", format = "bibtex"/);
});

test('un BibTeX que no es de Scopus ni de WoS se rechaza con una explicación', () => {
  assert.throws(() => bibliografia.preparar(bytes('@book{a, title={b}}'), 'bibtex-otro'), bibliografia.BibliografiaNoValida);
});

test('r.formato manda el exporte a bibliometrix y el BibTeX ajeno lo rechaza como archivo no válido', () => {
  const p = formato.preparar(bytes(SCOPUS_TXT));
  assert.equal(p.tipo, 'bibliografia');
  assert.match(p.lectura, /bibliometrix::convert2df/);

  assert.throws(() => formato.preparar(bytes('@book{mio,\n title={Mi libro}\n}')), formato.ArchivoNoValido);

  // Y la matriz sigue yendo por donde iba.
  assert.equal(formato.preparar(bytes('sep=;\r\nid;sexo\r\n1;F\r\n')).tipo, 'csv');
});
