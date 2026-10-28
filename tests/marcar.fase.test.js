'use strict';

/**
 * «Dar por terminada» desde el panel (27-oct-2026). Antes solo la IA cerraba
 * una fase; quien subía su avance veía «0 de 9 terminadas». Reabrir deja la
 * fase en curso, nunca pendiente, porque su texto sigue guardado.
 *
 * La base y el catálogo se sustituyen, como en `retomar.fase`.
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
  { code: 'HUMANIZADOR', displayName: 'Humanizador académico' },
];

const estado = { proyecto: null, conLicencia: [], guardadas: [] };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto ?? { id: 'nuevo' },
  guardarEtapa: async (projectId, skillCode, cambios) => {
    estado.guardadas.push({ projectId, skillCode, ...cambios });
    return {};
  },
  productosConLicencia: async () => estado.conLicencia,
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => CATALOGO,
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});

const projectService = require('../src/modules/projects/project.service');

const marcar = (capitulo, terminada) =>
  projectService.marcarFase({ userId: 'u1', productCode: 'METODO_9_SKILLS', capitulo, terminada });

test('terminada deja la fase LISTO y devuelve su nombre', async () => {
  estado.proyecto = { id: 'p1', stages: [{ skillCode: 'CAP1', estado: 'EN_CURSO' }] };
  estado.guardadas = [];
  const r = await marcar('CAP1', true);
  assert.equal(r.ok, true);
  assert.equal(r.nombre, '2 · Capítulo I · Problema y objetivos');
  assert.deepEqual(estado.guardadas, [{ projectId: 'p1', skillCode: 'CAP1', estado: 'LISTO' }]);
});

test('reabrir la deja EN_CURSO, no PENDIENTE', async () => {
  estado.proyecto = { id: 'p1', stages: [{ skillCode: 'CAP1', estado: 'LISTO' }] };
  estado.guardadas = [];
  await marcar('CAP1', false);
  assert.equal(estado.guardadas[0].estado, 'EN_CURSO');
});

test('rechaza herramientas de apoyo y claves ajenas sin escribir nada', async () => {
  estado.proyecto = { id: 'p1', stages: [] };
  estado.guardadas = [];
  assert.equal((await marcar('HUMANIZADOR', true)).error, 'no-es-fase');
  assert.equal((await marcar('OTRA', true)).error, 'no-es-fase');
  assert.equal(estado.guardadas.length, 0);
});

test('sin proyecto ni licencia de ese método no crea nada', async () => {
  estado.proyecto = null;
  estado.conLicencia = [];
  estado.guardadas = [];
  assert.equal((await marcar('CAP1', true)).error, 'sin-proyecto');
  assert.equal(estado.guardadas.length, 0);
});

test('con licencia y sin proyecto todavía, lo crea y marca', async () => {
  estado.proyecto = null;
  estado.conLicencia = ['METODO_9_SKILLS'];
  estado.guardadas = [];
  const r = await marcar('TEMA', true);
  assert.equal(r.ok, true);
  assert.equal(estado.guardadas[0].projectId, 'nuevo');
});
