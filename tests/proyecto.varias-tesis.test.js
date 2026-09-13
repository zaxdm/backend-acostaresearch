'use strict';

/**
 * Varias tesis del mismo método.
 *
 * Por defecto una por licencia. Pueden abrir más el administrador y quien tenga
 * encendido «varias tesis» en la licencia de ese método. Lo que se prueba: que
 * el panel enseña UNA fila por método —la activa, la misma que usa el conector—
 * con la lista de todas; a quién se le ofrece abrir otra; que abrirla exige
 * licencia y permiso; y que la última tesis no se borra por este camino. La
 * base y el disco se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const estado = {
  guardados: [],
  conLicencia: [],
  conPermiso: [],
  cuantas: 0,
  pasos: [],
  existe: true,
};

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  listarDeUsuario: async () => estado.guardados,
  productosConLicencia: async () => estado.conLicencia,
  productosConVariasTesis: async () => estado.conPermiso,
  nombresDeProducto: async (codigos) => new Map(codigos.map((c) => [c, `Plan ${c}`])),
  crearTesis: async (userId, productCode, nombre) => {
    estado.pasos.push(`crear:${nombre}`);
    return { id: 'nueva', productCode, nombre };
  },
  buscarTesis: async (userId, productCode, id) => (estado.existe ? { id } : null),
  contarTesis: async () => estado.cuantas,
  eliminarTesis: async (userId, productCode, id) => {
    estado.pasos.push(`base:${id}`);
    return 1;
  },
});
sustituir('../src/modules/projects/project.storage', {
  borrarProyecto: async (id) => {
    estado.pasos.push(`disco:${id}`);
  },
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [{ code: 'tema', displayName: '1 · Tema y delimitación' }],
});
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

function empezar(cambios = {}) {
  Object.assign(
    estado,
    { guardados: [], conLicencia: [], conPermiso: [], cuantas: 0, pasos: [], existe: true },
    cambios,
  );
}

const tesis = (id, ranura, activadaAt, extra = {}) => ({
  id,
  productCode: 'METODO',
  ranura,
  nombre: ranura === 0 ? null : `Prueba ${ranura}`,
  activadaAt: new Date(activadaAt),
  tema: `Tema ${id}`,
  updatedAt: new Date(activadaAt),
  stages: [{ skillCode: 'tema', estado: 'EN_CURSO', palabras: 10 }],
  ...extra,
});

test('con varias tesis, el panel enseña una fila: la activada más tarde', async () => {
  empezar({
    guardados: [
      tesis('a', 0, '2026-09-01'),
      tesis('c', 2, '2026-09-03'),
      tesis('b', 1, '2026-09-10'),
    ],
    conLicencia: ['METODO'],
  });

  const panel = await projectService.deUsuario('u1', { esAdmin: true });

  assert.equal(panel.length, 1, 'un método, una fila');
  const [metodo] = panel;
  assert.equal(metodo.id, 'b');
  assert.equal(metodo.nombre, 'Prueba 1');
  assert.equal(metodo.tema, 'Tema b');
  assert.equal(metodo.puedeCrearTesis, true);
  assert.deepEqual(
    metodo.tesis.map((t) => [t.id, t.activa]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ],
    'la lista va por orden de creación y marca la activa',
  );
  assert.equal(metodo.tesis[0].palabras, 10);
});

test('si empatan en fecha, gana la más nueva', async () => {
  empezar({ guardados: [tesis('a', 0, '2026-09-01'), tesis('b', 1, '2026-09-01')] });
  const [metodo] = await projectService.deUsuario('u1');
  assert.equal(metodo.id, 'b');
});

test('a un comprador sin permiso no se le ofrece abrir otra tesis', async () => {
  empezar({ guardados: [tesis('a', 0, '2026-09-01')], conLicencia: ['METODO'] });
  const [metodo] = await projectService.deUsuario('u1');
  assert.equal(metodo.puedeCrearTesis, false);
  assert.equal(metodo.tesis.length, 1);
});

test('con el permiso en la licencia de ESE método, sí se le ofrece', async () => {
  empezar({
    guardados: [tesis('a', 0, '2026-09-01')],
    conLicencia: ['METODO', 'OTRO'],
    conPermiso: ['METODO'],
  });
  const panel = await projectService.deUsuario('u1');
  const porCodigo = Object.fromEntries(panel.map((p) => [p.productCode, p.puedeCrearTesis]));
  assert.deepEqual(porCodigo, { METODO: true, OTRO: false });
});

test('un método comprado sin nada guardado sale con la lista vacía', async () => {
  empezar({ conLicencia: ['METODO'] });
  const [metodo] = await projectService.deUsuario('u1', { esAdmin: true });
  assert.equal(metodo.guardado, false);
  assert.deepEqual(metodo.tesis, []);
});

test('abrir otra tesis exige licencia vigente de ese método, también al administrador', async () => {
  empezar({ conLicencia: ['OTRO'] });
  const r = await projectService.crearTesis({
    userId: 'u1',
    productCode: 'METODO',
    nombre: 'X',
    esAdmin: true,
  });
  assert.deepEqual(r, { error: 'sin-licencia' });
  assert.deepEqual(estado.pasos, []);
});

test('un comprador sin el permiso no puede abrir otra tesis', async () => {
  empezar({ conLicencia: ['METODO'], conPermiso: ['OTRO'] });
  const r = await projectService.crearTesis({ userId: 'u1', productCode: 'METODO', nombre: 'X' });
  assert.deepEqual(r, { error: 'sin-permiso' });
  assert.deepEqual(estado.pasos, []);
});

test('con el permiso, el comprador abre otra; el administrador no lo necesita', async () => {
  empezar({ conLicencia: ['METODO'], conPermiso: ['METODO'] });
  const comprador = await projectService.crearTesis({
    userId: 'u1',
    productCode: 'METODO',
    nombre: 'X',
  });
  assert.equal(comprador.tesis.id, 'nueva');

  empezar({ conLicencia: ['METODO'] });
  const admin = await projectService.crearTesis({
    userId: 'u1',
    productCode: 'METODO',
    nombre: 'Y',
    esAdmin: true,
  });
  assert.equal(admin.tesis.id, 'nueva');
  assert.deepEqual(estado.pasos, ['crear:Y']);
});

test('la única tesis no se borra por aquí', async () => {
  empezar({ cuantas: 1 });
  const r = await projectService.eliminarTesis({ userId: 'u1', productCode: 'METODO', id: 'a' });
  assert.equal(r, 'unica');
  assert.deepEqual(estado.pasos, []);
});

test('borrar una tesis ajena o inexistente no toca nada', async () => {
  empezar({ cuantas: 3, existe: false });
  const r = await projectService.eliminarTesis({ userId: 'u1', productCode: 'METODO', id: 'zz' });
  assert.equal(r, 'no-existe');
  assert.deepEqual(estado.pasos, []);
});

test('con otra al lado, se borra primero el disco y luego la base', async () => {
  empezar({ cuantas: 2 });
  const r = await projectService.eliminarTesis({ userId: 'u1', productCode: 'METODO', id: 'b' });
  assert.equal(r, 'borrada');
  assert.deepEqual(estado.pasos, ['disco:b', 'base:b']);
});
