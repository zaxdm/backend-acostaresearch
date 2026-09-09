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

const CATALOGO = [
  { code: 'tema-y-delimitacion', displayName: 'Tema y delimitación' },
  { code: 'problema-y-objetivos', displayName: 'Problema y objetivos' },
  { code: 'marco-teorico', displayName: 'Marco teórico' },
];

require.cache[rutaRepo] = { id: rutaRepo, filename: rutaRepo, loaded: true, exports: repo };
require.cache[rutaSkills] = {
  id: rutaSkills,
  filename: rutaSkills,
  loaded: true,
  exports: { listCatalog: async () => CATALOGO },
};

const projectService = require('../src/modules/projects/project.service');

function conProyecto(datos) {
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

  assert.match(t, /\[hecho\] Tema y delimitación/);
  assert.match(t, /\[pendiente\] Problema y objetivos/);
  assert.match(t, /\[pendiente\] Marco teórico/);
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
