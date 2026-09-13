'use strict';

/**
 * Un método comprado sale siempre en el panel.
 *
 * El caso real: un tesista con tesis y artículo borró el progreso de la tesis y
 * dejó de verla, como si no la tuviera. Lo que se prueba: que un método con
 * licencia vigente y sin nada guardado sale en blanco, que no sale dos veces si
 * ya tiene proyecto, y que desde ese panel en blanco se puede elegir la norma
 * —pero solo si la licencia es de ese método. La base se sustituye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const estado = { guardados: [], conLicencia: [], asegurados: [] };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  listarDeUsuario: async () => estado.guardados,
  productosConLicencia: async () => estado.conLicencia,
  nombresDeProducto: async (codigos) => new Map(codigos.map((c) => [c, `Plan ${c}`])),
  buscar: async (userId, productCode) =>
    estado.guardados.find((p) => p.productCode === productCode) ?? null,
  asegurar: async (userId, productCode, cambios = {}) => {
    estado.asegurados.push(productCode);
    return { id: 'nuevo', productCode, ...cambios };
  },
});

sustituir('../src/modules/projects/project.storage', {});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [
    { code: 'tema', displayName: 'Fase 0 — Tema y orientación' },
    { code: 'metodos', displayName: 'Fase 4 — Métodos' },
    { code: 'humanizador-academico', displayName: 'Humanizador académico' },
  ],
});
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

function empezar({ guardados = [], conLicencia = [] } = {}) {
  estado.guardados = guardados;
  estado.conLicencia = conLicencia;
  estado.asegurados = [];
}

const TESIS_GUARDADA = {
  id: 'p1',
  productCode: 'ARTICULO_SCIENTIFICOS',
  tema: 'Un tema',
  estiloCitas: null,
  idiomaCitas: null,
  plantillaAt: null,
  updatedAt: new Date(),
  stages: [{ skillCode: 'tema', estado: 'EN_CURSO', palabras: 0 }],
};

test('un método con licencia y sin nada guardado sale en blanco', async () => {
  empezar({ guardados: [TESIS_GUARDADA], conLicencia: ['ARTICULO_SCIENTIFICOS', 'METODO_DE_TESIS_HUMANIZADOR'] });

  const panel = await projectService.deUsuario('u1');

  assert.deepEqual(
    panel.map((p) => p.productCode),
    ['ARTICULO_SCIENTIFICOS', 'METODO_DE_TESIS_HUMANIZADOR'],
    'primero lo guardado, y cada método una sola vez',
  );

  const [guardado, enBlanco] = panel;
  assert.equal(guardado.guardado, true);
  assert.equal(enBlanco.guardado, false);
  assert.equal(enBlanco.productName, 'Plan METODO_DE_TESIS_HUMANIZADOR');
  assert.equal(enBlanco.tema, null);
  assert.deepEqual(enBlanco.avance, { listos: 0, total: 2 }, 'el humanizador no cuenta');
  assert.ok(enBlanco.etapas.every((e) => e.estado === 'PENDIENTE'));
  assert.equal(enBlanco.siguiente.code, 'tema', 'empieza por la primera fase');
});

test('sin licencia vigente ni proyecto, el panel sigue vacío', async () => {
  empezar();
  assert.deepEqual(await projectService.deUsuario('u1'), []);
});

test('desde un método en blanco se puede elegir la norma: se crea el proyecto', async () => {
  empezar({ conLicencia: ['METODO_DE_TESIS_HUMANIZADOR'] });

  const norma = await projectService.cambiarNorma({
    userId: 'u1',
    productCode: 'METODO_DE_TESIS_HUMANIZADOR',
    estiloCitas: 'ieee',
  });

  assert.equal(norma.estilo, 'ieee');
  assert.deepEqual(estado.asegurados, ['METODO_DE_TESIS_HUMANIZADOR']);
});

test('sin licencia de ese método, elegir la norma no crea nada', async () => {
  empezar({ conLicencia: ['ARTICULO_SCIENTIFICOS'] });

  const norma = await projectService.cambiarNorma({
    userId: 'u1',
    productCode: 'METODO_DE_TESIS_HUMANIZADOR',
    estiloCitas: 'ieee',
  });

  assert.equal(norma, null);
  assert.deepEqual(estado.asegurados, []);
});
