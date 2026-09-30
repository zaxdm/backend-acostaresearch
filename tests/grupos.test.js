'use strict';

/**
 * Grupos (universidades y asesores): el alta con su cobro, unirse con la
 * cuenta propia y lo que ve el coordinador.
 *
 * Lo que no puede pasar: que un alumno ocupe dos cupos, que alguien que ya
 * pagó el método gaste uno, que se entregue un cupo de más o que el cobro del
 * grupo se quede fuera de las ventas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const db = { grupo: null, licencias: [], pagos: [], usuarios: [], proyectos: [] };

const prisma = {
  grupo: {
    fields: { cupos: 'cupos' },
    findUnique: async ({ where }) => {
      const g = db.grupo;
      if (!g || (where.slug && g.slug !== where.slug) || (where.id && g.id !== where.id)) return null;
      return { ...g, coordinador: db.usuarios[0] };
    },
    create: async ({ data }) => {
      db.grupo = { id: 'g-1', ocupados: 0, activo: true, createdAt: new Date(), ...data };
      return { id: 'g-1' };
    },
    update: async ({ data }) => Object.assign(db.grupo, data),
    updateMany: async ({ where }) => {
      const g = db.grupo;
      const hay = g && g.id === where.id && g.activo && g.ocupados < g.cupos;
      if (hay) g.ocupados += 1;
      return { count: hay ? 1 : 0 };
    },
    findMany: async () => [{ ...db.grupo, coordinador: db.usuarios[0], licencias: db.licencias }],
  },
  license: {
    findFirst: async ({ where }) =>
      db.licencias.find((l) => l.userId === where.userId && l.productCode === where.productCode) ?? null,
    create: async ({ data }) => {
      const l = { id: `lic-${db.licencias.length + 1}`, status: 'ACTIVE', callsTotal: 0, createdAt: new Date(), ...data };
      db.licencias.push(l);
      return l;
    },
  },
  payment: {
    create: async ({ data }) => {
      db.pagos.push(data);
      return { id: 'pago-1' };
    },
  },
  user: {
    findUnique: async ({ where }) =>
      db.usuarios.find((u) => u.email === where.email || u.id === where.id) ?? null,
  },
  plan: {
    findFirst: async () => ({
      id: 'plan-tesis',
      name: 'Método de tesis',
      priceCents: 29900,
      durationDays: 90,
      mcpCallsPerDay: 0,
      mcpCallsPerMonth: 0,
      mcpCostCentsPerMonth: 0,
      mcpCallsTotal: 0,
      mcpCostCentsTotal: 0,
      mcpDelivery: 'EXECUTED',
    }),
    findMany: async () => [{ productCode: 'METODO_9_SKILLS', name: 'Método de tesis' }],
  },
  project: { findMany: async () => db.proyectos },
  skill: { findMany: async () => [{ code: 'marco', displayName: 'Marco teórico' }] },
  $transaction: async (fn) => fn(prisma),
};

sustituir('../src/lib/prisma', prisma);
sustituir('../src/lib/mailer', { sendMail: async () => ({ messageId: 'x' }) });
sustituir('../src/shared/utils/correo', { revisarCorreos: async (lista) => lista.map((c) => ({ correo: c })) });

const grupos = require('../src/modules/grupos/grupos.service');

function reiniciar({ cupos = 2 } = {}) {
  db.usuarios = [
    { id: 'coord', email: 'asesor@uni.edu.pe', firstName: 'Luis', lastName: 'Pérez', status: 'ACTIVE', trialLinkId: null },
    { id: 'al-1', email: 'a1@x.com', firstName: 'Ana', lastName: 'Ruiz', status: 'ACTIVE' },
  ];
  db.licencias = [];
  db.pagos = [];
  db.proyectos = [];
  db.grupo = null;
  return grupos.crear({
    nombre: 'Maestría UCV 2026-II',
    productCode: 'METODO_9_SKILLS',
    cupos,
    coordinadorEmail: 'Asesor@Uni.edu.pe ',
    paymentMethod: 'TRANSFERENCIA',
    paymentRef: 'OP-123',
    amountCents: 150000,
    createdById: 'admin',
  });
}

test('el estado del grupo: abierto, lleno, cerrado por fecha o apagado', () => {
  const base = { activo: true, cupos: 3, ocupados: 1, cierraAt: null };
  assert.equal(grupos.estadoDelGrupo(base), 'ABIERTO');
  assert.equal(grupos.estadoDelGrupo({ ...base, ocupados: 3 }), 'LLENO');
  assert.equal(grupos.estadoDelGrupo({ ...base, cierraAt: new Date(Date.now() - 1000) }), 'CERRADO');
  assert.equal(grupos.estadoDelGrupo({ ...base, activo: false }), 'APAGADO');
  assert.match(grupos.generarSlug(), /^[a-z0-9]{10}$/);
});

test('el alta apunta el cobro a nombre del coordinador, para que entre en las ventas', async () => {
  const grupo = await reiniciar();
  assert.equal(grupo.estado, 'ABIERTO');
  assert.match(grupo.url, /\/grupo\/[a-z0-9]{10}$/);
  assert.equal(db.pagos.length, 1);
  assert.equal(db.pagos[0].userId, 'coord');
  assert.equal(db.pagos[0].status, 'PAID');
  assert.equal(db.pagos[0].amountCents, 150000);
  assert.equal(db.pagos[0].providerOrderId, 'GRUPO-g-1');
});

test('sin cuenta del coordinador no hay grupo', async () => {
  db.usuarios = [];
  await assert.rejects(
    grupos.crear({ nombre: 'X', productCode: 'METODO_9_SKILLS', cupos: 1, coordinadorEmail: 'nadie@x.com' }),
    /tiene que tener cuenta/,
  );
});

test('una cortesía no apunta ningún cobro', async () => {
  db.usuarios = [{ id: 'coord', email: 'asesor@uni.edu.pe', status: 'ACTIVE', trialLinkId: null }];
  db.pagos = [];
  await grupos.crear({
    nombre: 'Piloto',
    productCode: 'METODO_9_SKILLS',
    cupos: 5,
    coordinadorEmail: 'asesor@uni.edu.pe',
    paymentMethod: 'CORTESIA',
    amountCents: 150000,
  });
  assert.equal(db.pagos.length, 0);
});

test('el alumno se une y recibe su propia licencia, del grupo y con la duración del plan', async () => {
  await reiniciar();
  const r = await grupos.unirse(db.grupo.slug, 'al-1');
  assert.equal(r.yaEstaba, false);
  assert.match(r.connectorUrl, /\/mcp\//);
  assert.equal(db.licencias[0].grupoId, 'g-1');
  assert.equal(db.licencias[0].userId, 'al-1');
  const dias = Math.round((db.licencias[0].expiresAt - Date.now()) / 86400000);
  assert.equal(dias, 90);
  assert.equal(db.grupo.ocupados, 1);
});

test('unirse dos veces no gasta otro cupo', async () => {
  await reiniciar();
  await grupos.unirse(db.grupo.slug, 'al-1');
  const r = await grupos.unirse(db.grupo.slug, 'al-1');
  assert.equal(r.yaEstaba, true);
  assert.equal(db.grupo.ocupados, 1);
  assert.equal(db.licencias.length, 1);
});

test('quien ya compró el método no ocupa un cupo', async () => {
  await reiniciar();
  db.licencias.push({ id: 'suya', userId: 'al-1', productCode: 'METODO_9_SKILLS', grupoId: null });
  await assert.rejects(grupos.unirse(db.grupo.slug, 'al-1'), /Ya tienes este método/);
  assert.equal(db.grupo.ocupados, 0);
});

test('lleno, no entrega más', async () => {
  await reiniciar({ cupos: 1 });
  await grupos.unirse(db.grupo.slug, 'al-1');
  await assert.rejects(grupos.unirse(db.grupo.slug, 'al-2'), /no tiene cupos libres/);
});

test('el coordinador ve el avance de cada alumno, no su texto', async () => {
  await reiniciar();
  await grupos.unirse(db.grupo.slug, 'al-1');
  db.licencias[0].user = { firstName: 'Ana', lastName: 'Ruiz', email: 'a1@x.com' };
  db.licencias[0].callsTotal = 12;
  db.proyectos = [
    {
      userId: 'al-1',
      productCode: 'METODO_9_SKILLS',
      tema: 'Liderazgo y clima',
      plantillaAt: null,
      stages: [
        { skillCode: 'tema', estado: 'LISTO', updatedAt: new Date() },
        { skillCode: 'marco', estado: 'EN_CURSO', updatedAt: new Date() },
      ],
    },
  ];

  const [grupo] = await grupos.mios('coord');
  assert.equal(grupo.quedan, 1);
  assert.deepEqual(grupo.alumnos[0], {
    nombre: 'Ana Ruiz',
    email: 'a1@x.com',
    seUnio: db.licencias[0].createdAt,
    activo: true,
    conecto: true,
    ultimoUso: undefined,
    fasesTerminadas: 1,
    faseActual: 'Marco teórico',
    tema: 'Liderazgo y clima',
    formatoSubido: false,
  });
});
