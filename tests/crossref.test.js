'use strict';

/**
 * Crossref, que aquí solo hace una cosa: completar lo que falta.
 *
 * Es el registro donde el editor deposita el DOI, así que es la autoridad sobre
 * volumen, número y páginas. No es un buscador —casi no trae resúmenes— y por
 * eso este cliente no tiene búsqueda: se consulta por DOI y punto.
 *
 * Lo que se prueba es la regla que lo hace seguro: **no pisa nada**. Lo que ya
 * está vino del export del tesista o de su Zotero, donde alguien lo revisó, y
 * Crossref abrevia los nombres de las revistas de formas que un asesor no
 * reconocería.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaEnv = require.resolve('../src/config/env');
require.cache[rutaEnv] = {
  id: rutaEnv,
  filename: rutaEnv,
  loaded: true,
  exports: { OPENALEX_MAILTO: 'hola@acostaresearch.com' },
};

const rutaLogger = require.resolve('../src/config/logger');
require.cache[rutaLogger] = {
  id: rutaLogger,
  filename: rutaLogger,
  loaded: true,
  exports: { info: () => {}, warn: () => {}, error: () => {} },
};

const crossref = require('../src/modules/references/crossref.client');

/** La respuesta de Crossref para 10.1000/abc, recortada a lo que se usa. */
const RESPUESTA = {
  message: {
    DOI: '10.1000/abc',
    title: ['Construct validity revisited'],
    author: [
      { given: 'Roberto', family: 'Hernández' },
      { given: 'Carlos', family: 'Fernández' },
    ],
    'container-title': ['Journal of Testing'],
    volume: '12',
    issue: '3',
    page: '45-67',
    issued: { 'date-parts': [[2021, 5, 10]] },
    type: 'journal-article',
    URL: 'https://doi.org/10.1000/abc',
  },
};

function fingir(t, { estado = 200, cuerpo = RESPUESTA } = {}) {
  const original = global.fetch;
  const llamadas = [];

  global.fetch = async (url) => {
    llamadas.push(String(url));
    return { ok: estado >= 200 && estado < 300, status: estado, json: async () => cuerpo };
  };

  t.after(() => {
    global.fetch = original;
  });

  return llamadas;
}

test('la ficha por DOI trae lo que hace falta para citar', async (t) => {
  fingir(t);

  const ficha = await crossref.porDoi('https://doi.org/10.1000/abc');

  assert.equal(ficha.title, 'Construct validity revisited');
  assert.equal(ficha.authors, 'Hernández, R.; Fernández, C.');
  assert.equal(ficha.year, 2021);
  assert.equal(ficha.source, 'Journal of Testing');
  assert.equal(ficha.volume, '12');
  assert.equal(ficha.issue, '3');
  assert.equal(ficha.pages, '45-67');
});

test('se identifica con un correo: sin eso Crossref atiende por la cola lenta', async (t) => {
  const llamadas = fingir(t);

  await crossref.porDoi('10.1000/abc');

  assert.match(llamadas[0], /mailto=hola%40acostaresearch\.com/);
});

test('completar rellena los huecos y NO pisa lo que ya venía', async (t) => {
  fingir(t);

  const completada = await crossref.completar({
    doi: '10.1000/abc',
    title: 'El título del export, que es el bueno',
    source: 'Revista de Educación',
    volume: null,
    issue: null,
    pages: null,
  });

  assert.equal(completada.title, 'El título del export, que es el bueno');
  assert.equal(
    completada.source,
    'Revista de Educación',
    'Crossref abrevia nombres de revista: si ya hay uno revisado, manda ese',
  );
  assert.equal(completada.volume, '12');
  assert.equal(completada.issue, '3');
  assert.equal(completada.pages, '45-67');
});

test('si no falta nada, no se gasta una petición', async (t) => {
  const llamadas = fingir(t);

  const ficha = {
    doi: '10.1000/abc',
    source: 'Revista de Educación',
    volume: '15',
    issue: '2',
    pages: '45-62',
  };
  const completada = await crossref.completar(ficha);

  assert.deepEqual(completada, ficha);
  assert.equal(llamadas.length, 0);
});

test('sin DOI no hay nada que preguntar', async (t) => {
  const llamadas = fingir(t);

  const ficha = { doi: null, source: null, volume: null, pages: null };
  assert.deepEqual(await crossref.completar(ficha), ficha);
  assert.equal(llamadas.length, 0);
});

test('un DOI que Crossref no conoce devuelve la ficha tal cual, no un error', async (t) => {
  fingir(t, { estado: 404, cuerpo: {} });

  const ficha = { doi: '10.1000/no-existe', source: 'Revista', volume: null, pages: null };

  assert.equal(await crossref.porDoi(ficha.doi), null);
  assert.deepEqual(await crossref.completar(ficha), ficha);
});

test('el resumen de Crossref viene con etiquetas XML dentro y se limpian', async (t) => {
  fingir(t, {
    cuerpo: {
      message: {
        ...RESPUESTA.message,
        abstract: '<jats:p>Un resumen <jats:italic>con</jats:italic> etiquetas.</jats:p>',
      },
    },
  });

  const ficha = await crossref.porDoi('10.1000/abc');

  assert.equal(ficha.abstract, 'Un resumen con etiquetas.');
});

// ── Buscar por tema: el respaldo de OpenAlex ────────────────────────────────

const BUSQUEDA = {
  message: {
    'total-results': 52879,
    items: [
      {
        DOI: '10.37811/cl_rcm.v6i2.2089',
        title: ['Clima organizacional y <i>desempeño</i> laboral'],
        author: [{ given: 'Ana', family: 'Quispe Mamani' }],
        issued: { 'date-parts': [[2022]] },
        'container-title': ['Ciencia Latina Revista Científica Multidisciplinar'],
        'is-referenced-by-count': 10,
        abstract: '<jats:p>El objetivo fue determinar la relación.</jats:p>',
      },
      { DOI: '10.1000/sin-titulo', title: [] },
    ],
  },
};

test('buscar devuelve fichas con la misma forma que las de OpenAlex', async (t) => {
  const llamadas = fingir(t, { cuerpo: BUSQUEDA });

  const { fuentes, total, caida } = await crossref.buscar({
    tema: 'clima organizacional',
    desdeAnio: 2020,
    cuantas: 5,
  });

  assert.equal(caida, false);
  assert.equal(total, 52879);
  assert.equal(fuentes.length, 1, 'una obra sin título no sirve para citar');
  assert.deepEqual(fuentes[0], {
    titulo: 'Clima organizacional y desempeño laboral',
    autores: 'Quispe Mamani, A.',
    anio: 2022,
    revista: 'Ciencia Latina Revista Científica Multidisciplinar',
    doi: '10.37811/cl_rcm.v6i2.2089',
    citas: 10,
    idioma: null,
    pdfLibre: null,
    resumen: 'El objetivo fue determinar la relación.',
  });

  const url = new URL(llamadas[0]);
  assert.equal(url.searchParams.get('query.bibliographic'), 'clima organizacional');
  assert.equal(url.searchParams.get('filter'), 'type:journal-article,from-pub-date:2020');
  assert.ok(
    !url.searchParams.get('select').split(',').includes('language'),
    'Crossref rechaza con 400 un select de «language»',
  );
});

test('si Crossref no contesta al buscar, se dice caída', async (t) => {
  fingir(t, { estado: 503 });

  assert.deepEqual(await crossref.buscar({ tema: 'lo que sea' }), {
    fuentes: [],
    total: 0,
    caida: true,
  });
});
