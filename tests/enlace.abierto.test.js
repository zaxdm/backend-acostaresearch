'use strict';

/**
 * El enlace al texto abierto que se pega a los resultados del buscador.
 *
 * LO QUE AQUÍ SE DEFIENDE
 * -----------------------
 * Tres cosas, y ninguna es de adorno:
 *
 *   · **A Unpaywall solo se le pregunta por lo que OpenAlex no conoce.** Los
 *     dos catálogos beben de la misma fuente, y preguntar por los veinticinco
 *     de una página serían veinticinco peticiones sueltas contra un servicio
 *     gratuito para confirmar lo que ya se sabía. Si alguien «arregla» esto
 *     algún día, esta prueba se cae.
 *   · **Si los catálogos no contestan, la búsqueda sale igual.** Un enlace de
 *     cortesía no puede tumbar una búsqueda que ya gastó una petición de la
 *     cuota semanal de Elsevier.
 *   · **La versión viaja hasta la vista.** Un preprint no es el artículo
 *     publicado, y quien lo cite creyendo que sí tiene un problema que el
 *     asesor le va a encontrar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/config/logger', {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
});

const enlaceAbierto = require('../src/modules/references/enlaceAbierto');

/** Un catálogo de mentira que contesta lo que se le diga y anota qué le pidieron. */
function catalogoFalso(respuestas, registro = []) {
  return {
    async enlacesAbiertosPorDoi(dois) {
      registro.push([...dois]);
      const mapa = new Map();
      for (const doi of dois) {
        if (Object.hasOwn(respuestas, doi)) mapa.set(doi, respuestas[doi]);
      }
      return mapa;
    },
  };
}

const PDF_NATURE = {
  url: 'https://www.nature.com/articles/x.pdf',
  esPdf: true,
  version: 'publishedVersion',
  licencia: 'cc-by',
  donde: 'Nature',
};

test('el enlace de OpenAlex llega al resultado, con su versión y su licencia', async () => {
  const catalogo = catalogoFalso({ '10.1/abierto': PDF_NATURE });
  const respaldo = catalogoFalso({});

  const [resultado] = await enlaceAbierto.pegarALosResultados(
    [{ eid: 'e1', titulo: 'Uno', doi: '10.1/abierto' }],
    { catalogo, respaldo },
  );

  assert.equal(resultado.enlaceAbierto.url, PDF_NATURE.url);
  assert.equal(resultado.enlaceAbierto.esPdf, true);
  assert.equal(resultado.enlaceAbierto.version, 'publishedVersion');
  assert.equal(resultado.enlaceAbierto.licencia, 'cc-by');
  assert.equal(resultado.enlaceAbierto.catalogo, 'openalex');
  // No se pierde nada de lo que ya traía el resultado.
  assert.equal(resultado.titulo, 'Uno');
});

test('a Unpaywall solo se le preguntan los DOI que OpenAlex NO conoce', async () => {
  const pedidosAOpenAlex = [];
  const pedidosAUnpaywall = [];
  /**
   * `10.1/con` lo conoce y tiene copia; `10.1/sin` lo conoce y NO la tiene
   * —ese `null` es su respuesta, y vale—; `10.1/nuevo` no lo conoce.
   */
  const catalogo = catalogoFalso({ '10.1/con': PDF_NATURE, '10.1/sin': null }, pedidosAOpenAlex);
  const respaldo = catalogoFalso(
    { '10.1/nuevo': { ...PDF_NATURE, donde: 'Repositorio' } },
    pedidosAUnpaywall,
  );

  const resultados = await enlaceAbierto.pegarALosResultados(
    [
      { eid: 'e1', titulo: 'Con copia', doi: '10.1/con' },
      { eid: 'e2', titulo: 'Sin copia', doi: '10.1/sin' },
      { eid: 'e3', titulo: 'Recién depositado', doi: '10.1/nuevo' },
    ],
    { catalogo, respaldo },
  );

  assert.deepEqual(pedidosAOpenAlex, [['10.1/con', '10.1/sin', '10.1/nuevo']]);
  // LO IMPORTANTE: ni `10.1/con` ni `10.1/sin` vuelven a preguntarse.
  assert.deepEqual(pedidosAUnpaywall, [['10.1/nuevo']]);

  assert.equal(resultados[0].enlaceAbierto.catalogo, 'openalex');
  assert.equal(resultados[1].enlaceAbierto, null);
  assert.equal(resultados[2].enlaceAbierto.catalogo, 'unpaywall');
});

test('si OpenAlex lo conoce todo, a Unpaywall no se le pregunta nada', async () => {
  const pedidos = [];
  const catalogo = catalogoFalso({ '10.1/a': PDF_NATURE, '10.1/b': null });
  const respaldo = catalogoFalso({}, pedidos);

  await enlaceAbierto.pegarALosResultados(
    [
      { eid: 'e1', titulo: 'A', doi: '10.1/a' },
      { eid: 'e2', titulo: 'B', doi: '10.1/b' },
    ],
    { catalogo, respaldo },
  );

  assert.deepEqual(pedidos, []);
});

test('un preprint se marca como preprint y no como el artículo publicado', async () => {
  const catalogo = catalogoFalso({
    '10.1/preprint': { ...PDF_NATURE, version: 'submittedVersion', donde: 'arXiv' },
  });

  const [resultado] = await enlaceAbierto.pegarALosResultados(
    [{ eid: 'e1', titulo: 'Borrador', doi: '10.1/preprint' }],
    { catalogo, respaldo: catalogoFalso({}) },
  );

  assert.equal(resultado.enlaceAbierto.version, 'submittedVersion');
  assert.equal(resultado.enlaceAbierto.donde, 'arXiv');
});

test('la copia abierta en la propia editorial se marca como repetida del DOI', async () => {
  const catalogo = catalogoFalso({
    '10.1371/journal.pone.0173160': {
      url: 'https://doi.org/10.1371/journal.pone.0173160',
      esPdf: false,
      version: 'publishedVersion',
      licencia: 'cc-by',
      donde: 'PLoS ONE',
    },
  });

  const [resultado] = await enlaceAbierto.pegarALosResultados(
    [{ eid: 'e1', titulo: 'PLoS', doi: '10.1371/journal.pone.0173160' }],
    { catalogo, respaldo: catalogoFalso({}) },
  );

  // Sigue siendo acceso abierto —eso se dice— pero la vista no pone un segundo
  // botón al mismo sitio al que ya lleva «Ver en la editorial».
  assert.equal(resultado.enlaceAbierto.mismoQueEditorial, true);
});

test('un resultado sin DOI se queda sin enlace y no hace preguntar a nadie', async () => {
  const pedidos = [];
  const catalogo = catalogoFalso({}, pedidos);

  const resultados = await enlaceAbierto.pegarALosResultados(
    [{ eid: 'e1', titulo: 'Sin DOI', doi: null }],
    { catalogo, respaldo: catalogoFalso({}) },
  );

  // Siempre null, nunca undefined: la vista comprueba una cosa sola.
  assert.equal(resultados[0].enlaceAbierto, null);
  assert.deepEqual(pedidos, []);
});

test('si los dos catálogos se caen, los resultados salen intactos', async () => {
  const roto = {
    async enlacesAbiertosPorDoi() {
      throw new Error('la red se cayó');
    },
  };

  const resultados = await enlaceAbierto.pegarALosResultados(
    [{ eid: 'e1', titulo: 'Uno', doi: '10.1/a', citas: 7 }],
    { catalogo: roto, respaldo: roto },
  );

  assert.equal(resultados.length, 1);
  assert.equal(resultados[0].titulo, 'Uno');
  assert.equal(resultados[0].citas, 7);
});

test('el mismo DOI repetido en la página se pregunta una sola vez', async () => {
  const pedidos = [];
  const catalogo = catalogoFalso({ '10.1/a': PDF_NATURE }, pedidos);

  const resultados = await enlaceAbierto.pegarALosResultados(
    [
      { eid: 'e1', titulo: 'Uno', doi: '10.1/A' },
      { eid: 'e2', titulo: 'El mismo con otras mayúsculas', doi: '10.1/a' },
    ],
    { catalogo, respaldo: catalogoFalso({}) },
  );

  assert.deepEqual(pedidos, [['10.1/a']]);
  // A los dos les toca el enlace: el DOI se compara en minúsculas.
  assert.equal(resultados[0].enlaceAbierto.url, PDF_NATURE.url);
  assert.equal(resultados[1].enlaceAbierto.url, PDF_NATURE.url);
});

test('esLaMismaPaginaQueElDoi reconoce el doi.org y no confunde otros enlaces', () => {
  const mismo = enlaceAbierto.esLaMismaPaginaQueElDoi;
  assert.equal(mismo('https://doi.org/10.1/a', '10.1/a'), true);
  assert.equal(mismo('https://dx.doi.org/10.1/A', '10.1/a'), true);
  assert.equal(mismo('https://repositorio.edu.pe/10.1/a.pdf', '10.1/a'), false);
  assert.equal(mismo('https://doi.org/10.1/otro', '10.1/a'), false);
  assert.equal(mismo(null, '10.1/a'), false);
});
