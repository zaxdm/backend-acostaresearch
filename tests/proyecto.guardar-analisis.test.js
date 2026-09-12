'use strict';

/**
 * guardar_analisis en el servicio de verdad: que las cifras se sumen.
 *
 * Reproduce lo que pasó en uso real el 12 de septiembre de 2026. Un asistente
 * mandó 37 cifras y quedaron 8; mandó 8 más y borraron las anteriores; y en los
 * dos casos la respuesta dijo «Guardado» sin más. Aquí se manda lo mismo contra
 * el servicio, con la base y el disco sustituidos por unos en memoria que SÍ
 * guardan lo que se les escribe, y se mira qué queda.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaSkills = require.resolve('../src/modules/skills/skill.service');
const rutaAlmacen = require.resolve('../src/modules/projects/project.storage');

const CAPITULO = 'analisis-datos-rstudio';

/** Una base en memoria que guarda lo que se le escribe, y cuenta las escrituras. */
const repo = {
  proyecto: null,
  escrituras: 0,
  buscar: async () => repo.proyecto,
  asegurar: async (userId, productCode) => {
    if (!repo.proyecto) repo.proyecto = { id: 'p1', productCode, stages: [] };
    return repo.proyecto;
  },
  guardarEtapa: async (projectId, skillCode, { datos, estado } = {}) => {
    repo.escrituras += 1;
    let etapa = repo.proyecto.stages.find((e) => e.skillCode === skillCode);
    if (!etapa) {
      etapa = { skillCode, estado: 'PENDIENTE', datos: null };
      repo.proyecto.stages.push(etapa);
    }
    if (datos !== undefined) etapa.datos = datos;
    if (estado) etapa.estado = estado;
    return etapa;
  },
  listarDeUsuario: async () => [],
};

const almacen = {
  guardarAnalisis: async () => [],
  leerAnalisis: async () => null,
  fechaDeAnalisis: async () => null,
};

require.cache[rutaRepo] = { id: rutaRepo, filename: rutaRepo, loaded: true, exports: repo };
require.cache[rutaAlmacen] = {
  id: rutaAlmacen,
  filename: rutaAlmacen,
  loaded: true,
  exports: almacen,
};
require.cache[rutaSkills] = {
  id: rutaSkills,
  filename: rutaSkills,
  loaded: true,
  exports: { listCatalog: async () => [] },
};

const projectService = require('../src/modules/projects/project.service');

const guardar = (resultados, extra = {}) =>
  projectService.guardarAnalisis({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    capitulo: CAPITULO,
    resultados,
    ...extra,
  });

const guardadas = () =>
  repo.proyecto.stages.find((e) => e.skillCode === CAPITULO)?.datos?.resultados ?? [];

const unasCifras = (n, desde = 0) =>
  Array.from({ length: n }, (_, i) => `cifra ${desde + i} = 0.${100 + desde + i}`);

function empezar() {
  repo.proyecto = null;
  repo.escrituras = 0;
}

test('37 cifras y luego 8 más: quedan 45, no 8', async () => {
  empezar();

  const primera = await guardar(unasCifras(37));
  assert.equal(primera.cifras.nuevas, 37);
  assert.equal(guardadas().length, 37);

  const segunda = await guardar(unasCifras(8, 37));
  assert.equal(segunda.cifras.nuevas, 8);
  assert.equal(guardadas().length, 45, 'las 37 de antes siguen ahí');
});

test('mandar solo lo que ya estaba no escribe en la base', async () => {
  empezar();
  await guardar(['r = 0.5112']);
  const antes = repo.escrituras;

  const r = await guardar(['r = 0.5112']);

  assert.equal(r.cifras.repetidas, 1);
  assert.equal(repo.escrituras, antes);
});

test('con reemplazar, lo guardado se sustituye entero', async () => {
  empezar();
  await guardar(unasCifras(10));

  const r = await guardar(['r = 0.5112'], { reemplazar: true });

  assert.equal(r.cifras.sustituidas, 10);
  assert.deepEqual(guardadas(), ['r = 0.5112']);
});

test('guardar cifras no borra los demás datos del capítulo', async () => {
  empezar();
  await guardar(['r = 0.5112']);
  repo.proyecto.stages[0].datos.hallazgos = ['Relación positiva moderada'];

  await guardar(['p = 0.00003']);

  assert.deepEqual(repo.proyecto.stages[0].datos.hallazgos, ['Relación positiva moderada']);
  assert.deepEqual(guardadas(), ['r = 0.5112', 'p = 0.00003']);
});

test('en un artículo las cifras también se guardan', async () => {
  // El capítulo de resultados del artículo no estaba en el registro de etapas,
  // y guardar_analisis no guardaba ninguna cifra de un artículo.
  empezar();

  const r = await projectService.guardarAnalisis({
    userId: 'u1',
    productCode: 'ARTICULO_SCIENTIFICOS',
    capitulo: 'articulo-fase5-resultados',
    resultados: ['r = 0.5112', 'p = 0.00003'],
  });

  assert.equal(r.cifras.nuevas, 2);
  const etapa = repo.proyecto.stages.find((e) => e.skillCode === 'articulo-fase5-resultados');
  assert.deepEqual(etapa.datos.resultados, ['r = 0.5112', 'p = 0.00003']);
});
