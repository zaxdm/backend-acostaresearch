'use strict';

/**
 * Los indicadores de una revista desde la Serial Title API (vista CITESCORE).
 * La entrada es la forma real que devolvió Elsevier el 5-nov-2026 para
 * Education and Information Technologies, recortada.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { comoRevista, cuartilDe } = require('../src/modules/scopus/scopus.revistas');

const ENTRADA = {
  'dc:title': 'Education and Information Technologies',
  'dc:publisher': 'Springer',
  'source-id': '144955',
  'prism:issn': '1360-2357',
  'prism:eIssn': '1573-7608',
  openaccess: null,
  'subject-area': [
    { '@code': '3304', $: 'Education' },
    { '@code': '3309', $: 'Library and Information Sciences' },
  ],
  SNIPList: { SNIP: [{ '@year': '2025', $: '2.703' }] },
  SJRList: { SJR: [{ '@year': '2025', $: '2.131' }] },
  citeScoreYearInfoList: {
    citeScoreYearInfo: [
      {
        '@year': '2026',
        '@status': 'In-Progress',
        citeScoreInformationList: [{ citeScoreInfo: [{ citeScore: '20.2', citeScoreSubjectRank: [{ subjectCode: '3304', rank: '10', percentile: '99' }] }] }],
      },
      {
        '@year': '2025',
        '@status': 'Complete',
        citeScoreInformationList: [
          {
            citeScoreInfo: [
              {
                citeScore: '15.5',
                citeScoreSubjectRank: [
                  { subjectCode: '3309', rank: '9', percentile: '72' },
                  { subjectCode: '3304', rank: '22', percentile: '98' },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  link: [{ '@ref': 'scopus-source', '@href': 'https://www.scopus.com/source/sourceInfo.url?sourceId=144955' }],
};

test('el cuartil sale del último año COMPLETO de CiteScore, por categoría y con su nombre', () => {
  const r = comoRevista(ENTRADA);
  assert.deepEqual(r.citeScore, { valor: '15.5', anio: '2025' });
  assert.deepEqual(r.sjr, { valor: '2.131', anio: '2025' });
  assert.deepEqual(
    r.categorias.map((c) => [c.categoria, c.cuartil]),
    [
      ['Education', 'Q1'],
      ['Library and Information Sciences', 'Q2'],
    ],
  );
  assert.match(r.enlace, /sourceId=144955/);
});

test('los cortes del cuartil de Scopus', () => {
  assert.equal(cuartilDe('75'), 'Q1');
  assert.equal(cuartilDe('74'), 'Q2');
  assert.equal(cuartilDe('50'), 'Q2');
  assert.equal(cuartilDe('25'), 'Q3');
  assert.equal(cuartilDe('3'), 'Q4');
  assert.equal(cuartilDe(undefined), null);
});

test('sin año completo de CiteScore no se inventa cuartil', () => {
  const r = comoRevista({ ...ENTRADA, citeScoreYearInfoList: { citeScoreYearInfo: [] } });
  assert.equal(r.citeScore, null);
  assert.deepEqual(r.categorias, []);
});
