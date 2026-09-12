'use strict';

/**
 * Lo que se prueba aquí es el texto que acaba leyendo el asistente, porque es
 * el producto entero de este módulo: si ese bloque no dice lo que hay que
 * decir, el tesista repite su tema por cuarta vez y da igual lo bien guardado
 * que esté en la base.
 *
 * La base de datos y el catálogo se sustituyen antes de cargar el servicio. No
 * hay base de datos en las pruebas, y tampoco hace falta: lo que decide si esto
 * sirve es cómo se redacta lo que se recuerda, no cómo se lee.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaSkills = require.resolve('../src/modules/skills/skill.service');

const repo = {
  proyecto: null,
  guardados: [],
  buscar: async () => repo.proyecto,
  asegurar: async (userId, productCode, cambios) => {
    repo.guardados.push({ tipo: 'proyecto', cambios });
    return { id: 'p1', productCode, ...cambios };
  },
  guardarEtapa: async (projectId, skillCode, datos) => {
    repo.guardados.push({ tipo: 'etapa', skillCode, datos });
    return { skillCode, ...datos };
  },
  listarDeUsuario: async () => [],
};

/**
 * El catálogo, nombrado como en producción.
 *
 * Las fases llevan su número delante y las herramientas de apoyo no: es lo que
 * mira `esApoyo` para separar el avance del método de lo que se usa cuando hace
 * falta. Un catálogo de prueba sin numerar no representa a ninguna licencia
 * real, y mientras estuvo así ninguna prueba podía ver que «lo siguiente»
 * acababa siendo el humanizador.
 */
const CATALOGO = [
  { code: 'tema-y-delimitacion', displayName: '1 · Tema y delimitación' },
  { code: 'problema-y-objetivos', displayName: '2 · Problema y objetivos' },
  { code: 'marco-teorico', displayName: '3 · Marco teórico' },
  { code: 'bajar-similitud', displayName: 'Bajar similitud' },
  { code: 'humanizador-academico', displayName: 'Humanizador académico' },
];

/** Las fases del método de artículo se llaman «Fase N», no «N ·». */
const CATALOGO_ARTICULO = [
  { code: 'articulo-fase0-tema', displayName: 'Fase 0 — Tema y orientación' },
  { code: 'articulo-fase5-resultados', displayName: 'Fase 5 — Resultados' },
  { code: 'humanizador-academico', displayName: 'Humanizador académico' },
];

/** Solo las fases, sin las herramientas de apoyo. */
const FASES = CATALOGO.filter((s) => /^\d/.test(s.displayName));

/**
 * Qué devuelve el catálogo en cada prueba. Las que necesitan otro orden lo
 * cambian aquí, y `conProyecto` lo repone para que no se filtre a la siguiente.
 */
const catalogos = {
  METODO_9_SKILLS: CATALOGO,
  ARTICULO_SCIENTIFICOS: CATALOGO_ARTICULO,
};

require.cache[rutaRepo] = { id: rutaRepo, filename: rutaRepo, loaded: true, exports: repo };
require.cache[rutaSkills] = {
  id: rutaSkills,
  filename: rutaSkills,
  loaded: true,
  exports: { listCatalog: async (productCode) => catalogos[productCode] ?? [] },
};

const projectService = require('../src/modules/projects/project.service');

function conProyecto(datos) {
  catalogos.METODO_9_SKILLS = CATALOGO;
  repo.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [], ...datos };
}

test('sin proyecto no se mete ningún bloque en la respuesta', async () => {
  repo.proyecto = null;
  assert.equal(await projectService.contexto('u1', 'METODO_9_SKILLS'), null);
});

test('un proyecto recién creado y vacío tampoco estorba', async () => {
  // Existir no es lo mismo que tener algo que contar. Un bloque que dice
  // «pendiente, pendiente, pendiente» ocupa sitio y no informa de nada.
  conProyecto({
    tema: null,
    stages: [{ skillCode: 'tema-y-delimitacion', estado: 'PENDIENTE', resumen: null }],
  });
  assert.equal(await projectService.contexto('u1', 'METODO_9_SKILLS'), null);
});

test('con tema, el bloque lo dice y ordena no volver a preguntarlo', async () => {
  conProyecto({ tema: 'Deserción universitaria en primer ciclo', carrera: 'Psicología' });

  const t = await projectService.contexto('u1', 'METODO_9_SKILLS');

  assert.match(t, /Deserción universitaria en primer ciclo/);
  assert.match(t, /Psicología/);
  assert.match(t, /NO se lo vuelvas a preguntar/);
});

test('salen también los capítulos que aún no ha tocado', async () => {
  // Saber lo que falta es la mitad de saber por dónde va. Si solo se listaran
  // las etapas guardadas, el asistente no vería el camino entero.
  conProyecto({
    tema: 'Un tema',
    stages: [{ skillCode: 'tema-y-delimitacion', estado: 'LISTO', resumen: 'Quedó acotado a Lima.' }],
  });

  const t = await projectService.contexto('u1', 'METODO_9_SKILLS');

  assert.match(t, /\[hecho\] 1 · Tema y delimitación/);
  assert.match(t, /\[pendiente\] 2 · Problema y objetivos/);
  assert.match(t, /\[pendiente\] 3 · Marco teórico/);
  assert.match(t, /quedó así: Quedó acotado a Lima\./);
});

test('lo siguiente que toca es el primer capítulo sin dar por bueno', async () => {
  conProyecto({
    tema: 'Un tema',
    stages: [
      { skillCode: 'tema-y-delimitacion', estado: 'LISTO', resumen: null },
      { skillCode: 'problema-y-objetivos', estado: 'EN_CURSO', resumen: null },
    ],
  });

  const siguiente = await projectService.siguientePaso('u1', 'METODO_9_SKILLS');
  assert.equal(siguiente.code, 'problema-y-objetivos');
});

test('cuando está todo dado por bueno, no hay siguiente', async () => {
  conProyecto({
    tema: 'Un tema',
    stages: CATALOGO.map((s) => ({ skillCode: s.code, estado: 'LISTO', resumen: null })),
  });

  assert.equal(await projectService.siguientePaso('u1', 'METODO_9_SKILLS'), null);
});

test('con las fases cerradas y el apoyo sin tocar, no queda siguiente', async () => {
  // El fallo de la Fase 3: quien cerraba sus capítulos recibía «Le toca: Bajar
  // similitud» en vez de enterarse de que había terminado.
  conProyecto({
    tema: 'Un tema',
    stages: FASES.map((s) => ({ skillCode: s.code, estado: 'LISTO' })),
  });

  assert.equal(await projectService.siguientePaso('u1', 'METODO_9_SKILLS'), null);
});

test('una herramienta de apoyo al principio del orden tampoco se propone', async () => {
  // Hoy van al final, pero eso lo decide el campo `orden` de la base, que se
  // edita. Si una se colara arriba, saldría desde el primer día.
  conProyecto({ tema: 'Un tema', stages: [] });
  catalogos.METODO_9_SKILLS = [
    { code: 'humanizador-academico', displayName: 'Humanizador académico' },
    ...FASES,
  ];

  const siguiente = await projectService.siguientePaso('u1', 'METODO_9_SKILLS');
  assert.equal(siguiente.code, 'tema-y-delimitacion');
});

test('un catálogo de solo herramientas de apoyo devuelve null, sin romperse', async () => {
  conProyecto({ tema: 'Un tema', stages: [] });
  catalogos.METODO_9_SKILLS = [
    { code: 'bajar-similitud', displayName: 'Bajar similitud' },
    { code: 'humanizador-academico', displayName: 'Humanizador académico' },
  ];

  assert.equal(await projectService.siguientePaso('u1', 'METODO_9_SKILLS'), null);
});

test('en el artículo, «Fase N» sigue siendo fase y no apoyo', async () => {
  repo.proyecto = {
    id: 'p1',
    productCode: 'ARTICULO_SCIENTIFICOS',
    tema: 'Un tema',
    stages: [{ skillCode: 'articulo-fase0-tema', estado: 'LISTO' }],
  };

  const siguiente = await projectService.siguientePaso('u1', 'ARTICULO_SCIENTIFICOS');
  assert.equal(siguiente.code, 'articulo-fase5-resultados');
});

test('y en el artículo, con sus fases cerradas, tampoco propone el humanizador', async () => {
  repo.proyecto = {
    id: 'p1',
    productCode: 'ARTICULO_SCIENTIFICOS',
    tema: 'Un tema',
    stages: [
      { skillCode: 'articulo-fase0-tema', estado: 'LISTO' },
      { skillCode: 'articulo-fase5-resultados', estado: 'LISTO' },
    ],
  };

  assert.equal(await projectService.siguientePaso('u1', 'ARTICULO_SCIENTIFICOS'), null);
});

test('guardar solo el estado no borra el resumen que ya había', async () => {
  // El asistente que marca LISTO sin mandar resumen no puede llevarse por
  // delante lo que se acordó. Se comprueba que ni siquiera se manda el campo.
  repo.guardados = [];
  conProyecto({ tema: 'Un tema' });

  await projectService.guardarAvance({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    capitulo: 'tema-y-delimitacion',
    estado: 'LISTO',
  });

  const etapa = repo.guardados.find((g) => g.tipo === 'etapa');
  assert.equal(etapa.datos.estado, 'LISTO');
  assert.equal(etapa.datos.resumen, undefined, 'no debe mandar resumen vacío');
});

test('guardar el tema no toca ninguna etapa', async () => {
  repo.guardados = [];
  conProyecto({});

  await projectService.guardarAvance({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    tema: 'Deserción universitaria',
  });

  assert.equal(repo.guardados.filter((g) => g.tipo === 'etapa').length, 0);
});

test('un resumen larguísimo se rechaza con un aviso que el asistente entiende', async () => {
  conProyecto({});

  await assert.rejects(
    projectService.guardarAvance({
      userId: 'u1',
      productCode: 'METODO_9_SKILLS',
      capitulo: 'marco-teorico',
      resumen: 'x'.repeat(1600),
    }),
    (error) => {
      assert.match(error.issues[0].message, /1500 caracteres/);
      return true;
    },
  );
});

test('un estado inventado no se guarda', async () => {
  conProyecto({});

  await assert.rejects(
    projectService.guardarAvance({
      userId: 'u1',
      productCode: 'METODO_9_SKILLS',
      capitulo: 'marco-teorico',
      estado: 'CASI_LISTO',
    }),
  );
});

test('anotar algo de un capítulo lo pone en curso', async () => {
  // Un capítulo con el tema y el periodo fijados no está «sin empezar», y el
  // panel diciendo que sí es sencillamente falso.
  repo.guardados = [];
  conProyecto({ stages: [] });

  await projectService.guardarAvance({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    capitulo: 'tema-y-delimitacion',
    resumen: 'Se acotó a primer ciclo.',
  });

  const etapa = repo.guardados.find((g) => g.tipo === 'etapa');
  assert.equal(etapa.datos.estado, 'EN_CURSO');
});

test('pero no rebaja un capítulo que ya estaba dado por bueno', async () => {
  repo.guardados = [];
  conProyecto({
    stages: [{ skillCode: 'tema-y-delimitacion', estado: 'LISTO', resumen: 'Cerrado.' }],
  });

  await projectService.guardarAvance({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    capitulo: 'tema-y-delimitacion',
    resumen: 'Una coma corregida.',
  });

  const etapa = repo.guardados.find((g) => g.tipo === 'etapa');
  assert.equal(etapa.datos.estado, undefined, 'no se toca el estado');
});
