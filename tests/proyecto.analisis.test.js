'use strict';

/**
 * El camino del análisis, desde la página de R hasta Claude.
 *
 * Tres cosas tienen que ser ciertas, y ninguna lo era antes de esta prueba:
 *
 *   · Lo que manda la web cae en el capítulo de resultados de SU método. El
 *     tesista no elige capítulo, y el de artículo no es el de tesis.
 *   · «mi_proyecto» avisa de que hay un análisis sin leer. Sin ese aviso el
 *     análisis se guarda y nadie lo abre: Claude no pregunta por lo que no sabe
 *     que existe.
 *   · El aviso se calla en cuanto hay cifras guardadas, que es la señal de que
 *     alguien ya lo leyó.
 *
 * El disco, la base y el catálogo se sustituyen antes de cargar el servicio: lo
 * que se comprueba es qué se guarda y qué lee el asistente, no cómo se escribe
 * un archivo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaSkills = require.resolve('../src/modules/skills/skill.service');
const rutaAlmacen = require.resolve('../src/modules/projects/project.storage');

const repo = {
  proyecto: null,
  buscar: async () => repo.proyecto,
  asegurar: async (userId, productCode) => {
    if (!repo.proyecto) repo.proyecto = { id: 'p1', productCode, stages: [] };
    return repo.proyecto;
  },
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
};

/** Un disco en memoria: `capitulo.tipo` → contenido. */
const almacen = {
  archivos: new Map(),
  guardarAnalisis: async (projectId, skillCode, { script, salida } = {}) => {
    const escritos = [];
    for (const [tipo, contenido] of Object.entries({ script, salida })) {
      if (!contenido) continue;
      almacen.archivos.set(`${skillCode}.${tipo}`, contenido);
      escritos.push(tipo);
    }
    return escritos;
  },
  leerAnalisis: async (projectId, skillCode, tipo) =>
    almacen.archivos.get(`${skillCode}.${tipo}`) ?? null,
  fechaDeAnalisis: async (projectId, skillCode) =>
    almacen.archivos.has(`${skillCode}.salida`) ? new Date('2026-09-10T12:00:00Z') : null,
};

const CATALOGOS = {
  METODO_9_SKILLS: [
    { code: 'tema-y-delimitacion', displayName: 'Tema y delimitación' },
    { code: 'analisis-datos-rstudio', displayName: 'Capítulo IV · Resultados' },
  ],
  ARTICULO_SCIENTIFICOS: [
    { code: 'articulo-fase0-tema-y-orientacion', displayName: 'Fase 0 — Tema' },
    { code: 'articulo-fase5-resultados', displayName: 'Fase 5 — Resultados' },
  ],
  SIN_RESULTADOS: [{ code: 'humanizador-academico', displayName: 'Humanizador' }],
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
  exports: { listCatalog: async (productCode) => CATALOGOS[productCode] ?? [] },
};

const projectService = require('../src/modules/projects/project.service');

function empezar() {
  repo.proyecto = null;
  almacen.archivos.clear();
}

function enviarDesdeLaWeb(productCode = 'METODO_9_SKILLS') {
  return projectService.recibirAnalisis({
    userId: 'u1',
    productCode,
    script: 'cor.test(datos$CD, datos$EMP)',
    salida: 'cor 0.5108 p-value = 0.00003',
  });
}

test('lo que manda la web cae en el capítulo de resultados de la tesis', async () => {
  empezar();
  const recibido = await enviarDesdeLaWeb();

  assert.equal(recibido.capitulo, 'analisis-datos-rstudio');
  assert.deepEqual(recibido.escritos, ['script', 'salida']);
});

test('y en el de resultados del artículo, si el método es el artículo', async () => {
  empezar();
  const recibido = await enviarDesdeLaWeb('ARTICULO_SCIENTIFICOS');

  assert.equal(recibido.capitulo, 'articulo-fase5-resultados');
});

test('un método sin capítulo de resultados no guarda nada', async () => {
  empezar();
  const recibido = await enviarDesdeLaWeb('SIN_RESULTADOS');

  assert.equal(recibido, null);
  assert.equal(almacen.archivos.size, 0);
});

test('mi_proyecto avisa del análisis sin leer, aunque no haya ningún otro avance', async () => {
  empezar();
  await enviarDesdeLaWeb();

  const texto = await projectService.contexto('u1', 'METODO_9_SKILLS');

  assert.ok(texto, 'sin el aviso, el análisis se queda guardado y nadie lo abre');
  assert.match(texto, /ANÁLISIS SIN LEER/);
  assert.match(texto, /ver_analisis/);
});

test('el aviso se calla en cuanto hay cifras guardadas de ese análisis', async () => {
  empezar();
  await enviarDesdeLaWeb();
  repo.proyecto.tema = 'Competencias digitales y empleabilidad';
  repo.proyecto.stages = [
    {
      skillCode: 'analisis-datos-rstudio',
      estado: 'EN_CURSO',
      datos: { resultados: ['r de Pearson = 0.5108'] },
    },
  ];

  const texto = await projectService.contexto('u1', 'METODO_9_SKILLS');

  assert.ok(texto);
  assert.doesNotMatch(texto, /ANÁLISIS SIN LEER/);
});

test('sin análisis guardado no hay aviso, y un proyecto vacío sigue sin estorbar', async () => {
  empezar();
  repo.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [] };

  assert.equal(await projectService.contexto('u1', 'METODO_9_SKILLS'), null);
});

test('ver_analisis devuelve el script, la salida y las cifras ya guardadas', async () => {
  empezar();
  await enviarDesdeLaWeb();
  repo.proyecto.stages = [
    {
      skillCode: 'analisis-datos-rstudio',
      estado: 'EN_CURSO',
      datos: { resultados: ['r de Pearson = 0.5108'] },
    },
  ];

  const leido = await projectService.leerAnalisis('u1', 'METODO_9_SKILLS');

  assert.equal(leido.capitulo, 'analisis-datos-rstudio');
  assert.equal(leido.script, 'cor.test(datos$CD, datos$EMP)');
  assert.equal(leido.salida, 'cor 0.5108 p-value = 0.00003');
  assert.deepEqual(leido.cifras, ['r de Pearson = 0.5108']);
});

test('sin nada guardado, ver_analisis no presenta un análisis vacío', async () => {
  empezar();
  repo.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [] };

  assert.equal(await projectService.leerAnalisis('u1', 'METODO_9_SKILLS'), null);
});
