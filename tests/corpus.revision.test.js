'use strict';

/**
 * El corpus de una revisión armado desde la conversación
 * (`references/corpus.revision`, herramienta "armar_corpus_de_busqueda").
 *
 * OpenAlex, Scopus y las bases externas van de mentira. Lo que se fija: un
 * archivo por base en el formato que lee corpus.py (CSV de OpenAlex o RIS), el
 * _todo.ris sin repetidos, el registro con la consulta literal, y que una base
 * caída no tumba a las demás.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaOpenalex = require.resolve('../src/modules/references/openalex.client');
const realOpenalex = require('../src/modules/references/openalex.client');
const rutaExternas = require.resolve('../src/modules/externas');

const pedidasAOpenalex = [];
let obrasDeLaBusqueda = [];
let obrasPorDoi = [];

require.cache[rutaOpenalex] = {
  id: rutaOpenalex,
  filename: rutaOpenalex,
  loaded: true,
  exports: {
    ...realOpenalex,
    async obrasDeUnaBusqueda(opciones) {
      pedidasAOpenalex.push(opciones);
      const filtro = `title_and_abstract.search:${opciones.consulta}${opciones.soloScielo ? ',primary_location.source.listed_in:scielo' : ''}`;
      return { obras: obrasDeLaBusqueda, total: 900, caida: false, filtro };
    },
    async obrasCompletasPorDoi(dois) {
      return obrasPorDoi.filter((w) => dois.includes(realOpenalex.limpiarDoi(w.doi)));
    },
    async obrasPorIds() {
      return [];
    },
  },
};

let pubmedCae = false;
const PUBMED = {
  clave: 'pubmed',
  nombre: 'PubMed',
  activa: () => true,
  async buscar({ pagina }) {
    if (pubmedCae) return { resultados: [], total: 0, caida: true };
    if (pagina > 1) return { resultados: [], total: 2, caida: false };
    return {
      total: 2,
      caida: false,
      resultados: [
        {
          id: '1',
          doi: '10.1234/uno',
          titulo: 'Technostress in nurses',
          autores: 'Pérez, J. A., García, M., & López, A.',
          anio: 2022,
          revista: 'J Nurs',
          idioma: 'en',
          resumen: 'Un resumen.',
          tipo: 'article',
        },
        { id: '2', doi: null, titulo: 'Otro', autores: 'Ruiz, P.', anio: 2021, revista: 'X', tipo: 'article' },
      ],
    };
  },
};
const APAGADA = { clave: 'core', nombre: 'CORE', activa: () => false, buscar: async () => ({ caida: true }) };

require.cache[rutaExternas] = {
  id: rutaExternas,
  filename: rutaExternas,
  loaded: true,
  exports: { base: (c) => ({ pubmed: PUBMED, core: APAGADA })[c] ?? null, BASES: [PUBMED, APAGADA] },
};

const corpus = require('../src/modules/references/corpus.revision');

const OBRA = (n, doi) => ({
  id: `https://openalex.org/W${n}`,
  doi: `https://doi.org/${doi}`,
  display_name: `Obra ${n}`,
  publication_year: 2023,
  type: 'article',
  language: 'en',
  cited_by_count: 10,
  primary_location: { source: { display_name: 'Revista', id: 'S1' } },
  authorships: [{ author: { display_name: 'Ana Pérez', id: 'A1' }, countries: ['PE'], institutions: [] }],
  keywords: [{ display_name: 'Technostress', score: 0.8 }],
  referenced_works: [],
  abstract_inverted_index: { Hola: [0], mundo: [1] },
});

const archivo = (hecho, nombre) => hecho.archivos.find((a) => a.nombre === nombre)?.bytes.toString('utf8');

test('arma un CSV por cada base de OpenAlex, un RIS por cada externa, el _todo.ris y el registro', async () => {
  obrasDeLaBusqueda = [OBRA(1, '10.1234/uno'), OBRA(2, '10.1234/dos')];
  obrasPorDoi = [OBRA(3, '10.1234/tres'), OBRA(1, '10.1234/uno')];
  pubmedCae = false;

  const hecho = await corpus.armar({
    clave: 'Tecnoestrés docente',
    bases: ['scopus', 'openalex', 'pubmed'],
    ecuacionScopus: 'TITLE-ABS-KEY(technostress)',
    consulta: 'technostress AND teacher*',
    desdeAnio: 2019,
    doisDeScopus: async ({ ecuacion, tope }) => {
      assert.equal(ecuacion, 'TITLE-ABS-KEY(technostress)');
      assert.equal(tope, 500);
      return { dois: ['10.1234/tres', '10.1234/uno', '10.1234/nadie'], total: 4, recorridos: 4 };
    },
    ahora: new Date('2026-11-05T12:00:00Z'),
  });

  assert.equal(hecho.clave, 'tecnoestres-docente');
  assert.deepEqual(
    hecho.archivos.map((a) => a.nombre).sort(),
    [
      'busqueda_tecnoestres-docente_openalex.csv',
      'busqueda_tecnoestres-docente_pubmed.ris',
      'busqueda_tecnoestres-docente_registro.txt',
      // La copia con fecha, que no se pisa al repetir la búsqueda otro día.
      'busqueda_tecnoestres-docente_registro_2026-11-05.txt',
      'busqueda_tecnoestres-docente_scopus.csv',
      'busqueda_tecnoestres-docente_todo.ris',
    ],
  );

  const scopus = hecho.bases.find((b) => b.clave === 'scopus');
  assert.equal(scopus.total, 4);
  assert.equal(scopus.bajados, 2);
  assert.deepEqual(scopus.notas, ['1 sin DOI', '1 con DOI que OpenAlex no conoce']);

  // El CSV es el de OpenAlex que leen bibliometrix y corpus.py.
  const csv = archivo(hecho, 'busqueda_tecnoestres-docente_scopus.csv');
  assert.match(csv.split('\n')[0], /"display_name".*"abstract"/);
  assert.match(csv, /"Hola mundo"/);

  // El RIS de PubMed: un AU por autor, con el resumen.
  const ris = archivo(hecho, 'busqueda_tecnoestres-docente_pubmed.ris');
  assert.match(ris, /AU {2}- Pérez, J\. A\.\r\nAU {2}- García, M\.\r\nAU {2}- López, A\./);
  assert.match(ris, /AB {2}- Un resumen\./);

  // Todo junto sin repetir el DOI 10.1234/uno (Scopus, OpenAlex y PubMed lo tienen).
  const todo = archivo(hecho, 'busqueda_tecnoestres-docente_todo.ris');
  assert.equal((todo.match(/^TY {2}-/gm) ?? []).length, 4);
  assert.equal(hecho.unicos, 4);

  // El registro, con la fecha y la consulta literal de cada base.
  const registro = archivo(hecho, 'busqueda_tecnoestres-docente_registro.txt');
  assert.match(registro, /Fecha: 2026-11-05/);
  assert.match(registro, /Consulta literal: TITLE-ABS-KEY\(technostress\)/);
  assert.match(registro, /Consulta literal: title_and_abstract\.search:technostress AND teacher\*/);

  // OpenAlex se pidió con los filtros: años y solo artículos y revisiones.
  assert.equal(pedidasAOpenalex.at(-1).desdeAnio, 2019);
  assert.deepEqual(pedidasAOpenalex.at(-1).tipos, ['article', 'review']);
});

test('una base caída o apagada no tumba a las demás, y se dice', async () => {
  obrasDeLaBusqueda = [OBRA(1, '10.1234/uno')];
  pubmedCae = true;

  const hecho = await corpus.armar({
    clave: 'x',
    bases: ['scielo', 'pubmed', 'core'],
    consulta: 'technostress',
  });

  const pubmed = hecho.bases.find((b) => b.clave === 'pubmed');
  assert.equal(pubmed.caida, true);
  assert.equal(pubmed.archivo, null);
  const core = hecho.bases.find((b) => b.clave === 'core');
  assert.match(core.notas[0], /apagada/);
  assert.ok(hecho.archivos.some((a) => a.nombre === 'busqueda_x_scielo.csv'));
  assert.equal(pedidasAOpenalex.at(-1).soloScielo, true);
});

test('no corre sin lo que cada base necesita', async () => {
  await assert.rejects(() => corpus.armar({ clave: 'x', bases: ['scopus'] }), /ecuación/);
  await assert.rejects(() => corpus.armar({ clave: 'x', bases: ['openalex'] }), /consulta/);
  await assert.rejects(() => corpus.armar({ clave: 'x', bases: ['wos'], consulta: 'a' }), /No conozco/);
});

test('los autores en APA se parten por persona, no por la coma del apellido', () => {
  assert.deepEqual(corpus.autoresDeApa('Pérez, J. A., García, M., & López, A.'), [
    'Pérez, J. A.',
    'García, M.',
    'López, A.',
  ]);
  assert.deepEqual(corpus.autoresDeApa('(Autor no consignado)'), []);
});

test('la herramienta es solo de la ruta de revisión, no del artículo empírico', () => {
  const { esRevision } = require('../src/modules/productos/producto.perfil');
  assert.equal(esRevision('ARTICULOS_REVIEW'), true);
  assert.equal(esRevision('ARTICULO_SCIENTIFICOS'), false);
  assert.equal(esRevision('METODO_DE_TESIS_HUMANIZADOR'), false);
});
