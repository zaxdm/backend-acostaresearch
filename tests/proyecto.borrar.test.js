'use strict';

/**
 * Empezar de cero.
 *
 * Lo que se prueba: que borrar pide la palabra, que se lleva la base Y la
 * carpeta del disco —en ese orden—, que un fallo del disco no deja al tesista
 * con un error después de haber borrado, y que borrar la cuenta ya no deja las
 * tesis colgando de una fila anónima. La base y el disco se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pasos = [];
const estado = { proyecto: null, discoRompe: false, cuentaProyectos: [] };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  borrar: async (projectId) => {
    pasos.push(`base:${projectId}`);
  },
});

sustituir('../src/modules/projects/project.storage', {
  borrarProyecto: async (projectId) => {
    if (estado.discoRompe) throw new Error('disco lleno de sorpresas');
    pasos.push(`disco:${projectId}`);
  },
});

sustituir('../src/modules/skills/skill.service', { listCatalog: async () => [] });
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

// Lo justo de la base para borrar una cuenta: cada operación anota su nombre y
// la transacción las da por buenas.
const anotar = (nombre) => (args) => {
  pasos.push(nombre);
  return args;
};
sustituir('../src/lib/prisma', {
  user: {
    findUnique: async () => ({
      id: 'u1',
      email: 'tesista@correo.com',
      firstName: 'Tesista',
      lastName: 'Prueba',
      role: 'CUSTOMER',
    }),
    update: anotar('user.update'),
  },
  project: {
    findMany: async () => estado.cuentaProyectos,
    deleteMany: anotar('project.deleteMany'),
  },
  license: { updateMany: anotar('license.updateMany') },
  accountCode: { deleteMany: anotar('accountCode.deleteMany') },
  refreshToken: { updateMany: anotar('refreshToken.updateMany') },
  $transaction: async (operaciones) => operaciones,
});
sustituir('../src/lib/mailer', { sendMail: async () => {} });
sustituir('../src/lib/notify', { avisarAlAdmin: () => {} });

const projectService = require('../src/modules/projects/project.service');
const { borrarProyectoSchema } = require('../src/modules/projects/project.schema');
const userService = require('../src/modules/users/user.service');

function empezar(cambios = {}) {
  pasos.length = 0;
  estado.discoRompe = false;
  estado.cuentaProyectos = [];
  estado.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [], ...cambios };
}

// ── La confirmación ─────────────────────────────────────────────────────────

test('borrar pide escribir «eliminar», sin importar mayúsculas ni espacios', () => {
  assert.equal(borrarProyectoSchema.safeParse({ confirmacion: '  ELIMINAR ' }).success, true);

  const otra = borrarProyectoSchema.safeParse({ confirmacion: 'borrar' });
  assert.equal(otra.success, false);
  assert.match(otra.error.issues[0].message, /eliminar/);

  assert.equal(borrarProyectoSchema.safeParse({}).success, false, 'sin palabra no se borra');
});

// ── El proyecto ─────────────────────────────────────────────────────────────

test('sin proyecto no hay nada que borrar, y no se toca nada', async () => {
  empezar();
  estado.proyecto = null;

  assert.equal(await projectService.borrarProyecto('u1', 'METODO_9_SKILLS'), false);
  assert.deepEqual(pasos, []);
});

test('se borra la base y después la carpeta del disco', async () => {
  empezar();

  assert.equal(await projectService.borrarProyecto('u1', 'METODO_9_SKILLS'), true);
  assert.deepEqual(pasos, ['base:p1', 'disco:p1']);
});

test('si el disco falla, el borrado igual se da por hecho', async () => {
  // La base ya no tiene el proyecto: devolver un error aquí haría creer al
  // tesista que su tesis sigue ahí, y volvería a intentarlo contra nada.
  empezar();
  estado.discoRompe = true;

  assert.equal(await projectService.borrarProyecto('u1', 'METODO_9_SKILLS'), true);
  assert.deepEqual(pasos, ['base:p1']);
});

// ── La cuenta ───────────────────────────────────────────────────────────────

test('borrar la cuenta se lleva sus proyectos, de la base y del disco', async () => {
  empezar();
  estado.cuentaProyectos = [{ id: 'p1' }, { id: 'p2' }];

  await userService.deleteOwnAccount('u1', { email: 'tesista@correo.com' });

  assert.ok(pasos.includes('project.deleteMany'), 'los proyectos salen de la base');
  assert.ok(pasos.includes('user.update'), 'y la cuenta se anonimiza como antes');
  assert.deepEqual(
    pasos.filter((p) => p.startsWith('disco:')),
    ['disco:p1', 'disco:p2'],
  );
  assert.ok(
    pasos.indexOf('project.deleteMany') < pasos.indexOf('disco:p1'),
    'el disco va después de la base',
  );
});
