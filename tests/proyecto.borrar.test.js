'use strict';

/**
 * Empezar de cero.
 *
 * Lo que se prueba: que pide la palabra, que vacía el disco Y la base —en ese
 * orden— dejando el proyecto en su sitio para que el panel lo enseñe en blanco,
 * que un fallo del disco no toca la base, y que borrar la cuenta ya no deja las
 * tesis colgando de una fila anónima. La base y el disco se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pasos = [];
const estado = { proyecto: null, discoRompe: false, cuentaProyectos: [], reinicios: 0 };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  reiniciar: async (projectId) => {
    pasos.push(`base:${projectId}`);
  },
  apartarReinicio: async (_projectId, tope) => {
    if (estado.reinicios >= tope) return false;
    estado.reinicios += 1;
    return true;
  },
  devolverReinicio: async () => {
    estado.reinicios -= 1;
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
const argumentos = {};
const anotar = (nombre) => (args) => {
  pasos.push(nombre);
  argumentos[nombre] = args;
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
  rewrite: { updateMany: anotar('rewrite.updateMany') },
  reference: { deleteMany: anotar('reference.deleteMany') },
  zoteroAccount: { deleteMany: anotar('zoteroAccount.deleteMany') },
  zoteroOauthRequest: { deleteMany: anotar('zoteroOauthRequest.deleteMany') },
  mendeleyAccount: { deleteMany: anotar('mendeleyAccount.deleteMany') },
  mendeleyOauthState: { deleteMany: anotar('mendeleyOauthState.deleteMany') },
  refreshToken: { deleteMany: anotar('refreshToken.deleteMany') },
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
  estado.reinicios = cambios.reinicios ?? 0;
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

  assert.deepEqual(await projectService.reiniciarProyecto('u1', 'METODO_9_SKILLS'), {
    error: 'sin-proyecto',
  });
  assert.deepEqual(pasos, []);
});

test('se vacía el disco y después se reinicia en la base, sin borrar el proyecto', async () => {
  empezar();

  assert.deepEqual(await projectService.reiniciarProyecto('u1', 'METODO_9_SKILLS'), { restantes: 2 });
  assert.deepEqual(pasos, ['disco:p1', 'base:p1']);
});

test('cada tesis puede empezar de cero tres veces, y la cuarta no toca nada', async () => {
  empezar({ reinicios: 2 });
  assert.deepEqual(await projectService.reiniciarProyecto('u1', 'METODO_9_SKILLS'), { restantes: 0 });

  empezar({ reinicios: 3 });
  assert.deepEqual(await projectService.reiniciarProyecto('u1', 'METODO_9_SKILLS'), {
    error: 'sin-reinicios',
  });
  assert.deepEqual(pasos, [], 'sin reinicios no se borra nada');
});

test('el administrador no tiene tope ni gasta reinicios', async () => {
  empezar({ reinicios: 3 });
  assert.deepEqual(
    await projectService.reiniciarProyecto('u1', 'METODO_9_SKILLS', { esAdmin: true }),
    { restantes: null },
  );
  assert.deepEqual(pasos, ['disco:p1', 'base:p1']);
  assert.equal(estado.reinicios, 3);
});

test('si el disco falla, se avisa y la base no se toca', async () => {
  // El proyecto conserva su identificador: dar por reiniciada una base con los
  // capítulos todavía en disco haría que el conector los volviera a encontrar.
  empezar();
  estado.discoRompe = true;

  await assert.rejects(projectService.reiniciarProyecto('u1', 'METODO_9_SKILLS'), /disco/);
  assert.deepEqual(pasos, []);
  assert.equal(estado.reinicios, 0, 'un borrado que falló no gasta un reinicio');
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

test('borrar la cuenta se lleva también sus fuentes, su Zotero, su Mendeley, sus sesiones y sus textos', async () => {
  // La política de privacidad lo promete: la fila anónima se queda por los
  // pagos, así que nada de esto se va solo por cascada.
  empezar();

  await userService.deleteOwnAccount('u1', { email: 'tesista@correo.com' });

  for (const paso of [
    'reference.deleteMany',
    'zoteroAccount.deleteMany',
    'zoteroOauthRequest.deleteMany',
    'mendeleyAccount.deleteMany',
    'mendeleyOauthState.deleteMany',
    'refreshToken.deleteMany',
    'rewrite.updateMany',
  ]) {
    assert.ok(pasos.includes(paso), `falta ${paso}`);
  }

  assert.deepEqual(
    argumentos['reference.deleteMany'].where,
    { ownerUserId: 'u1' },
    'solo sus fuentes: las del corpus no tienen dueño',
  );
  assert.deepEqual(argumentos['rewrite.updateMany'].data, { sourceText: '', resultText: null });
});
