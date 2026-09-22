'use strict';

/**
 * El mapeo bibliométrico de una búsqueda de Scopus: los DOI de Scopus, lo demás
 * de OpenAlex, y el CSV que lee bibliometrix con `dbsource = "openalex"`.
 *
 * Scopus y OpenAlex van de mentira. Que bibliometrix lea de verdad el CSV se
 * comprobó con R 4.6.1 y bibliometrix 5.5.0 contra 38 obras reales de OpenAlex
 * (21-sep-2026): los doce análisis de la casa salieron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaCliente = require.resolve('../src/modules/scopus/scopus.client');
const rutaOpenalex = require.resolve('../src/modules/references/openalex.client');
const realOpenalex = require('../src/modules/references/openalex.client');

const paginasPedidas = [];
let scopus = { total: 0, fichas: [] };
let obrasDeOpenalex = [];

require.cache[rutaCliente] = {
  id: rutaCliente,
  filename: rutaCliente,
  loaded: true,
  exports: {
    POR_PAGINA: 25,
    async buscar({ ecuacion, desde, cuantas }) {
      paginasPedidas.push({ ecuacion, desde, cuantas });
      return { total: scopus.total, desde, fichas: scopus.fichas.slice(desde, desde + cuantas) };
    },
  },
};
require.cache[rutaOpenalex] = {
  id: rutaOpenalex,
  filename: rutaOpenalex,
  loaded: true,
  exports: {
    ...realOpenalex,
    async obrasCompletasPorDoi(dois) {
      return obrasDeOpenalex.filter((w) => dois.includes(realOpenalex.limpiarDoi(w.doi)));
    },
    // Las referencias citadas, con su primer autor y su año, como obraDelMapa.
    async obrasPorIds(ids) {
      const conocidas = {
        W9: { id: 'W9', autores: ['Junco, R.'], anio: 2011, titulo: 'Uno' },
        W8: { id: 'W8', autores: ['Junco, R.'], anio: 2011, titulo: 'Otro estudio' },
      };
      return ids.map((id) => conocidas[realOpenalex.soloElId(id)]).filter(Boolean);
    },
  },
};

const mapeo = require('../src/modules/scopus/scopus.mapeo');
const bibliografia = require('../src/modules/r/r.bibliografia');

const OBRA = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1234/uno',
  display_name: 'Redes | sociales\ny rendimiento',
  publication_year: 2023,
  type: 'article',
  language: 'es',
  cited_by_count: 12,
  primary_location: { source: { display_name: 'Revista A', id: 'https://openalex.org/S1' } },
  authorships: [
    {
      author: { display_name: 'Ana Pérez', id: 'https://openalex.org/A1' },
      countries: ['PE'],
      institutions: [{ display_name: 'Universidad Nacional', id: 'https://openalex.org/I1', country_code: 'PE' }],
      is_corresponding: true,
    },
    // Sin país propio: se toma el de su institución.
    {
      author: { display_name: 'Luis Gómez', id: 'https://openalex.org/A2' },
      countries: [],
      institutions: [{ display_name: 'Universidad de Chile', id: 'https://openalex.org/I2', country_code: 'CL' }],
      is_corresponding: false,
    },
    // Sin institución ni país: hueco, para que el tercero siga siendo el tercero.
    { author: { display_name: 'Eva Ruiz', id: 'https://openalex.org/A3' }, countries: [], institutions: [] },
  ],
  keywords: [{ display_name: 'Redes sociales' }, { display_name: 'Rendimiento académico' }],
  referenced_works: ['https://openalex.org/W9', 'https://openalex.org/W8'],
  referenced_works_count: 2,
  abstract_inverted_index: { Un: [0], estudio: [1] },
};

function leerCsv(texto) {
  const filas = texto
    .trim()
    .split('\n')
    .map((linea) => [...linea.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')));
  const [cabecera, ...resto] = filas;
  return resto.map((fila) => Object.fromEntries(cabecera.map((c, i) => [c, fila[i]])));
}

test('cada autor lleva su país y su institución en la misma posición', () => {
  const [fila] = leerCsv(mapeo.csvDeOpenAlex([OBRA]));

  assert.equal(fila['authorships.author.display_name'], 'Ana Pérez|Luis Gómez|Eva Ruiz');
  assert.equal(fila['authorships.countries'], 'PE|CL|');
  assert.equal(fila['authorships.institutions.display_name'], 'Universidad Nacional|Universidad de Chile|');
  assert.equal(fila['authorships.is_corresponding'], 'true|false|false');
  assert.equal(fila['keywords.display_name'], 'Redes sociales|Rendimiento académico');
  assert.equal(fila.referenced_works, 'https://openalex.org/W9|https://openalex.org/W8');
  assert.equal(fila.abstract, 'Un estudio');
});

test('las referencias más citadas llevan «Autor, I. (año)» y las desconocidas su identificador', async () => {
  const obras = [OBRA, { ...OBRA, referenced_works: ['https://openalex.org/W9', 'https://openalex.org/W7'] }];
  const etiquetas = await mapeo.etiquetasDeReferencias(obras);

  assert.equal(etiquetas.get('https://openalex.org/W9'), 'Junco, R. (2011)');
  // Mismo autor y año: se distingue por el título.
  assert.equal(etiquetas.get('https://openalex.org/W8'), 'Junco, R. (2011) Otro estudio');

  const [fila] = leerCsv(mapeo.csvDeOpenAlex([obras[1]], etiquetas));
  assert.equal(fila.referenced_works, 'Junco, R. (2011)|https://openalex.org/W7');
});

test('de las palabras clave de OpenAlex quedan las específicas, sin los grandes campos', () => {
  const w = {
    keywords: [
      ['Chatbot', 0.57],
      ['Psychology', 0.57],
      ['Higher education', 0.52],
      ['Medical education', 0.39],
      ['Medicine', 0.12],
    ].map(([display_name, score]) => ({ display_name, score })),
  };
  assert.equal(mapeo.filaDe(w)['keywords.display_name'], 'Chatbot|Higher education');
});

test('el origen cuenta de dónde salieron los datos y las cifras del PRISMA', () => {
  const texto = mapeo.origenDelMapeo(
    'TITLE-ABS-KEY(redes)',
    { total: 693, recorridos: 693, conDoi: 645, documentos: 632 },
    new Date('2026-09-21T12:00:00Z'),
  );
  assert.match(texto, /buscador de acostaresearch\.com el 2026-09-21/);
  assert.match(texto, /No es un exporte de Scopus/);
  assert.match(texto, /Ecuación: TITLE-ABS-KEY\(redes\)/);
  assert.match(
    texto,
    /Resultados en Scopus con ese criterio: 693\. Tomados .*: 693\. Con DOI: 645\. Encontrados en OpenAlex: 632\./,
  );
  assert.match(texto, /solo artículos y revisiones \(DOCTYPE ar, re\)/);
  assert.match(texto, /metadatos de OpenAlex/);
});

test('el mapeo se pide a Scopus acotado a artículos y revisiones', async () => {
  paginasPedidas.length = 0;
  scopus = { total: 1, fichas: [{ 'prism:doi': '10.1234/uno' }] };
  obrasDeOpenalex = [OBRA];
  let origenLeido = null;

  await mapeo.prepararMapeo({
    ecuacion: 'TITLE-ABS-KEY(redes)',
    accessToken: null,
    subir: async (_bytes, origen) => {
      origenLeido = origen;
      return { leido: true };
    },
  });

  // La cláusula va DENTRO de la ecuación, para que quien la copie y la pegue
  // en Scopus vea el mismo corpus.
  assert.equal(
    paginasPedidas[0].ecuacion,
    '(TITLE-ABS-KEY(redes)) AND (DOCTYPE(ar) OR DOCTYPE(re))',
  );
  // Y es la que se le cuenta a Claude: es la que hay que declarar en Métodos.
  assert.match(origenLeido, /Ecuación: \(TITLE-ABS-KEY\(redes\)\) AND \(DOCTYPE\(ar\) OR DOCTYPE\(re\)\)/);
});

test('una búsqueda sin artículos ni revisiones lo dice, en vez de mapear otra cosa', async () => {
  scopus = { total: 0, fichas: [] };
  await assert.rejects(
    mapeo.prepararMapeo({ ecuacion: 'x', subir: async () => assert.fail('no debería subir nada') }),
    /no tiene artículos ni revisiones/,
  );
});

test('una barra o un salto dentro de un valor no parten la celda ni la fila', () => {
  const texto = mapeo.csvDeOpenAlex([OBRA]);
  assert.equal(texto.trim().split('\n').length, 2);
  assert.equal(leerCsv(texto)[0].display_name, 'Redes / sociales y rendimiento');
});

test('el CSV se reconoce como de OpenAlex y se lee con los países arreglados', () => {
  const bytes = Buffer.from(mapeo.csvDeOpenAlex([OBRA]));
  assert.equal(bibliografia.detectar(bytes), 'openalex-csv');

  const p = bibliografia.preparar(bytes, 'openalex-csv');
  assert.equal(p.archivo, 'datos.csv');
  assert.equal(
    p.lectura,
    'datos <- preparar_openalex(suppressWarnings(bibliometrix::convert2df("datos.csv", ' +
      'dbsource = "openalex", format = "csv")))',
  );
});

test('recorre la búsqueda de veinticinco en veinticinco y para en la última página', async () => {
  paginasPedidas.length = 0;
  scopus = {
    total: 450,
    fichas: Array.from({ length: 450 }, (_, i) => ({ 'prism:doi': i % 10 === 0 ? undefined : `10.1234/${i}` })),
  };

  const { dois, total, recorridos } = await mapeo.doisDeLaBusqueda({ ecuacion: 'x', accessToken: null });

  assert.deepEqual(
    paginasPedidas.map((p) => p.desde),
    Array.from({ length: 18 }, (_, i) => i * 25),
  );
  // Con nuestra clave, Elsevier rechaza más de 25 por página («Exceeds the
  // maximum number allowed for the service level», 21-sep-2026).
  assert.ok(paginasPedidas.every((p) => p.cuantas === 25));
  assert.equal(total, 450);
  assert.equal(recorridos, 450);
  assert.equal(dois.length, 405, 'los que no traen DOI no cuentan');
});

test('no pasa del tope de dos mil aunque la búsqueda tenga más', async () => {
  paginasPedidas.length = 0;
  scopus = { total: 9000, fichas: Array.from({ length: 9000 }, (_, i) => ({ 'prism:doi': `10.1234/${i}` })) };

  const { dois } = await mapeo.doisDeLaBusqueda({ ecuacion: 'x', accessToken: null });

  assert.equal(dois.length, mapeo.TOPE_DEL_MAPEO);
  assert.equal(Math.max(...paginasPedidas.map((p) => p.desde + p.cuantas)), mapeo.TOPE_DEL_MAPEO);
});

test('prepararMapeo sube el CSV a la sesión y cuenta lo que quedó fuera', async () => {
  scopus = { total: 3, fichas: [{ 'prism:doi': '10.1234/uno' }, { 'prism:doi': '10.1234/dos' }, {}] };
  obrasDeOpenalex = [OBRA];
  let subido = null;

  const r = await mapeo.prepararMapeo({
    ecuacion: 'redes',
    accessToken: null,
    subir: async (bytes, origen) => {
      subido = bytes.toString('utf8');
      assert.match(origen, /Resultados en Scopus con ese criterio: 3\. .*Con DOI: 2\. Encontrados en OpenAlex: 1\./);
      return { leido: true };
    },
  });

  assert.match(subido, /^"id","doi","display_name"/);
  assert.equal(r.total, 3);
  assert.equal(r.recorridos, 3);
  assert.equal(r.conDoi, 2);
  assert.equal(r.documentos, 1);
  assert.equal(r.sinDatos, 1, 'con DOI pero OpenAlex no la conoce');
  assert.equal(r.leido, true);
});

test('sin resultados, sin DOI o sin respuesta de OpenAlex, se dice y no se sube nada', async () => {
  const subir = async () => assert.fail('no debería subir nada');

  scopus = { total: 0, fichas: [] };
  await assert.rejects(mapeo.prepararMapeo({ ecuacion: 'x', subir }), /no tiene artículos ni revisiones/);

  scopus = { total: 2, fichas: [{}, {}] };
  await assert.rejects(mapeo.prepararMapeo({ ecuacion: 'x', subir }), /Ninguno de los resultados trae DOI/);

  scopus = { total: 1, fichas: [{ 'prism:doi': '10.1234/nada' }] };
  obrasDeOpenalex = [];
  await assert.rejects(mapeo.prepararMapeo({ ecuacion: 'x', subir }), /catálogo abierto no respondió/);
});
