'use strict';

/**
 * Por qué fase se retoma. Con varias a medias la elige el tesista en el panel;
 * sin elegir, la en curso o la primera sin cerrar. El panel y el conector
 * tienen que decir la misma.
 *
 * La base, el disco y el catálogo se sustituyen, como en `informe.panel`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const CATALOGO = [
  { code: 'TEMA', displayName: '1 · Tema y delimitación' },
  { code: 'CAP1', displayName: '2 · Capítulo I · Problema y objetivos' },
  { code: 'CAP2', displayName: '3 · Capítulo II · Marco teórico' },
  { code: 'RES', displayName: '7 · Capítulo IV · Resultados' },
  { code: 'HUMANIZADOR', displayName: 'Humanizador académico' },
];

const estado = { proyecto: null, elegido: undefined };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  elegirRetomar: async (_id, code) => {
    estado.elegido = code;
    estado.proyecto = { ...estado.proyecto, retomarEn: code };
  },
  nombreDe: async () => 'Alguien',
  listarDeUsuario: async () => (estado.proyecto ? [estado.proyecto] : []),
  productosConLicencia: async () => [],
  productosConVariasTesis: async () => [],
  nombresDeProducto: async () => new Map(),
  guardarEtapa: async () => ({}),
});
sustituir('../src/modules/projects/project.storage', {
  leerFichaDeDocumento: async () => null,
  leer: async () => null,
  leerPlantilla: async () => null,
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => CATALOGO,
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});

const projectService = require('../src/modules/projects/project.service');

const etapa = (skillCode, estadoEtapa) => ({ skillCode, estado: estadoEtapa, palabras: 0 });

const conEtapas = (stages, retomarEn = null) => ({
  id: 'p1',
  productCode: 'METODO_9_SKILLS',
  ranura: 0,
  nombre: null,
  activadaAt: null,
  tema: null,
  carrera: null,
  universidad: null,
  asesor: null,
  retomarEn,
  estiloCitas: null,
  idiomaCitas: null,
  plantillaAt: null,
  updatedAt: new Date('2026-09-16T00:00:00Z'),
  stages,
});

// Tema, Capítulo I y Resultados a medias: el caso de la captura.
const tresAMedias = [etapa('TEMA', 'EN_CURSO'), etapa('CAP1', 'EN_CURSO'), etapa('RES', 'EN_CURSO')];

test('sin elegir, la primera en curso, en el panel y en el conector', async () => {
  estado.proyecto = conEtapas(tresAMedias);
  const [p] = await projectService.deUsuario('u1');
  assert.equal(p.siguiente.code, 'TEMA');
  assert.equal(p.retomarElegido, false);
  assert.equal((await projectService.siguientePaso('u1', 'METODO_9_SKILLS')).code, 'TEMA');
});

test('la que eligió manda sobre el orden, en los dos sitios', async () => {
  estado.proyecto = conEtapas(tresAMedias, 'RES');
  const [p] = await projectService.deUsuario('u1');
  assert.equal(p.siguiente.code, 'RES');
  assert.equal(p.retomarElegido, true);
  assert.equal((await projectService.siguientePaso('u1', 'METODO_9_SKILLS')).code, 'RES');
});

test('puede elegir una sin empezar', async () => {
  estado.proyecto = conEtapas(tresAMedias, 'CAP2');
  const [p] = await projectService.deUsuario('u1');
  assert.equal(p.siguiente.code, 'CAP2');
});

test('en cuanto la elegida queda terminada, deja de mandar', async () => {
  estado.proyecto = conEtapas([...tresAMedias.filter((e) => e.skillCode !== 'RES'), etapa('RES', 'LISTO')], 'RES');
  const [p] = await projectService.deUsuario('u1');
  assert.equal(p.siguiente.code, 'TEMA');
  assert.equal(p.retomarElegido, false);
});

test('elegir: acepta una fase abierta y null vuelve a la automática', async () => {
  estado.proyecto = conEtapas(tresAMedias);
  assert.deepEqual(
    await projectService.cambiarRetomar({ userId: 'u1', productCode: 'METODO_9_SKILLS', capitulo: 'CAP1' }),
    { ok: true },
  );
  assert.equal(estado.elegido, 'CAP1');
  await projectService.cambiarRetomar({ userId: 'u1', productCode: 'METODO_9_SKILLS', capitulo: null });
  assert.equal(estado.elegido, null);
});

test('elegir: rechaza herramientas de apoyo, claves ajenas y fases cerradas', async () => {
  estado.proyecto = conEtapas([etapa('TEMA', 'LISTO')]);
  estado.elegido = undefined;
  const intentar = (capitulo) =>
    projectService.cambiarRetomar({ userId: 'u1', productCode: 'METODO_9_SKILLS', capitulo });
  assert.equal((await intentar('HUMANIZADOR')).error, 'no-es-fase');
  assert.equal((await intentar('OTRA_COSA')).error, 'no-es-fase');
  assert.equal((await intentar('TEMA')).error, 'cerrada');
  assert.equal(estado.elegido, undefined);
});
