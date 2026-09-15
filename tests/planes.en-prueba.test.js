'use strict';

/**
 * Planes «en prueba» (`Plan.soloPara`).
 *
 * Lo que tiene que ser cierto para probar un producto nuevo con una sola
 * persona sin que se entere nadie más:
 *
 *   · no sale en la lista pública, que es la de la web y la del asistente;
 *   · no se puede comprar escribiendo su código;
 *   · solo se emite al administrador que está en la lista, y a los demás no se
 *     les emite ni se les revoca nada;
 *   · sus capítulos no asoman por el catálogo público;
 *   · y un plan sin `soloPara` sigue exactamente como antes.
 *
 * La base se sustituye: un filtro mínimo sobre filas en memoria.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

/** ¿Cumple la fila el `where` de Prisma? Lo justo que usan estos módulos. */
function cumple(fila, where = {}) {
  return Object.entries(where).every(([campo, valor]) => {
    if (valor === undefined) return true;
    if (valor !== null && typeof valor === 'object') {
      if ('not' in valor) return fila[campo] !== valor.not;
      if ('in' in valor) return valor.in.includes(fila[campo]);
      if ('notIn' in valor) return !valor.notIn.includes(fila[campo]);
    }
    return fila[campo] === valor;
  });
}

const ESTEBAN = 'esteban.dioses@tecsup.edu.pe';

const base = { planes: [], licencias: [], skills: [], creadas: [], ultimoPlan: null };

sustituir('../src/lib/prisma', {
  plan: {
    findMany: async ({ where }) => base.planes.filter((p) => cumple(p, where)),
    findUnique: async ({ where }) => base.planes.find((p) => cumple(p, where)) ?? null,
    findFirst: async ({ where }) => base.planes.find((p) => cumple(p, where)) ?? null,
    create: async ({ data }) => (base.ultimoPlan = { id: 'plan-nuevo', ...data }),
    update: async ({ data }) => {
      base.ultimaEdicion = data;
      return (base.ultimoPlan = { ...base.planes[0], ...data });
    },
  },
  license: {
    findMany: async ({ where }) => base.licencias.filter((l) => cumple(l, where)),
    create: async ({ data }) => {
      base.creadas.push(data);
      return { id: `l-${base.creadas.length}`, ...data };
    },
    updateMany: async () => ({ count: 0 }),
  },
  skill: { findMany: async () => base.skills },
  skillGroup: { groupBy: async () => [] },
  user: { findUnique: async () => null },
});
sustituir('../src/lib/mailer', { sendMail: async () => {} });
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });

const visibilidad = require('../src/modules/billing/plan.visibilidad');
const billingRepository = require('../src/modules/billing/billing.repository');
const billingService = require('../src/modules/billing/billing.service');
const licenseService = require('../src/modules/licensing/license.service');
const skillService = require('../src/modules/skills/skill.service');
const productService = require('../src/modules/billing/product.service');
const { createProductSchema, updateProductSchema } = require('../src/modules/billing/billing.schema');

const plan = (datos) => ({
  kind: 'LICENSE',
  active: true,
  soloPara: null,
  mcpDelivery: 'INSTRUCTIONS',
  name: datos.code,
  productCode: datos.code,
  ...datos,
});

const CATALOGO_REAL = [
  plan({ code: 'METODO_DE_TESIS_HUMANIZADOR' }),
  plan({ code: 'ARTICULO_SCIENTIFICOS' }),
  plan({ code: 'INFORME_ESTUDIANTIL', soloPara: 'Esteban.Dioses@tecsup.edu.pe' }),
];

function empezar() {
  base.planes = CATALOGO_REAL.map((p) => ({ ...p }));
  base.licencias = [];
  base.creadas = [];
  base.ultimoPlan = null;
}

// ── El ayudante ────────────────────────────────────────────────────────────

test('soloPara vacío o nulo es un plan normal, visible para todos', () => {
  for (const soloPara of [null, undefined, '', '  , ; ']) {
    assert.equal(visibilidad.enPrueba({ soloPara }), false, JSON.stringify(soloPara));
    assert.equal(visibilidad.visiblePara({ soloPara }, null), true);
  }
});

test('en prueba solo lo ve quien está en la lista, sin distinguir mayúsculas', () => {
  const p = { soloPara: 'Esteban.Dioses@tecsup.edu.pe, otra@correo.pe' };
  assert.equal(visibilidad.enPrueba(p), true);
  assert.equal(visibilidad.visiblePara(p, ESTEBAN), true);
  assert.equal(visibilidad.visiblePara(p, ' OTRA@correo.pe '), true);
  assert.equal(visibilidad.visiblePara(p, 'intruso@correo.pe'), false);
  assert.equal(visibilidad.visiblePara(p, null), false, 'sin correo, no se sabe: no se enseña');
});

test('se guarda sin repetir, en minúsculas, o null si no queda nada', () => {
  assert.equal(visibilidad.normalizar('A@b.pe; a@b.pe\nc@d.pe'), 'a@b.pe, c@d.pe');
  assert.equal(visibilidad.normalizar('   '), null);
  assert.equal(visibilidad.normalizar(null), null);
});

// ── La venta ───────────────────────────────────────────────────────────────

test('la lista pública deja fuera los planes en prueba y nada más', async () => {
  empezar();
  const codigos = (await billingRepository.listPlans()).map((p) => p.code);
  assert.deepEqual(codigos, ['METODO_DE_TESIS_HUMANIZADOR', 'ARTICULO_SCIENTIFICOS']);
});

test('un plan en prueba no se puede comprar por su código; uno normal sí', async () => {
  empezar();
  await assert.rejects(() => billingService.findPlan('INFORME_ESTUDIANTIL'), /No existe un plan activo/);
  assert.equal((await billingService.findPlan('ARTICULO_SCIENTIFICOS')).code, 'ARTICULO_SCIENTIFICOS');
});

// ── Las licencias de los administradores ──────────────────────────────────

test('al administrador de la lista se le emiten los normales y el de prueba', async () => {
  empezar();
  await licenseService.ensureForAdmin('admin-esteban', ESTEBAN);
  assert.deepEqual(base.creadas.map((l) => l.productCode).sort(), [
    'ARTICULO_SCIENTIFICOS',
    'INFORME_ESTUDIANTIL',
    'METODO_DE_TESIS_HUMANIZADOR',
  ]);
});

test('a otro administrador solo los normales, como antes', async () => {
  empezar();
  await licenseService.ensureForAdmin('admin-otro', 'otro.admin@acostaresearch.com');
  assert.deepEqual(base.creadas.map((l) => l.productCode).sort(), [
    'ARTICULO_SCIENTIFICOS',
    'METODO_DE_TESIS_HUMANIZADOR',
  ]);
});

test('sin correo, tampoco el de prueba', async () => {
  empezar();
  await licenseService.ensureForAdmin('admin-sin-correo');
  assert.ok(!base.creadas.some((l) => l.productCode === 'INFORME_ESTUDIANTIL'));
});

// ── El catálogo público ────────────────────────────────────────────────────

const SKILLS = [
  { code: 'metodologia', displayName: 'Metodología', groups: [{ productCode: 'METODO_DE_TESIS_HUMANIZADOR' }] },
  { code: 'informe-fase0-encargo', displayName: 'Encargo', groups: [{ productCode: 'INFORME_ESTUDIANTIL' }] },
  {
    code: 'humanizador-academico',
    displayName: 'Humanizador',
    groups: [{ productCode: 'METODO_DE_TESIS_HUMANIZADOR' }, { productCode: 'INFORME_ESTUDIANTIL' }],
  },
  { code: 'suelta', displayName: 'Sin grupo', groups: [] },
];

test('el catálogo público no enseña lo que es solo de un producto en prueba', async () => {
  empezar();
  base.skills = SKILLS;
  const codigos = (await skillService.listCatalogPublico()).map((s) => s.code);
  assert.deepEqual(codigos, ['metodologia', 'humanizador-academico', 'suelta']);
});

test('pedir el grupo en prueba por su código devuelve vacío', async () => {
  empezar();
  base.skills = SKILLS;
  assert.deepEqual(await skillService.listCatalogPublico('INFORME_ESTUDIANTIL'), []);
});

test('sin productos en prueba, el catálogo público es el de siempre', async () => {
  empezar();
  base.planes = base.planes.filter((p) => !p.soloPara);
  base.skills = SKILLS;
  assert.deepEqual(await skillService.listCatalogPublico(), await skillService.listCatalog());
});

// ── El panel ───────────────────────────────────────────────────────────────

test('el alta y la edición del grupo validan los correos', () => {
  const alta = { code: 'INFORME_ESTUDIANTIL', name: 'Informe', priceCents: 100 };
  assert.equal(createProductSchema.safeParse({ ...alta, soloPara: ESTEBAN }).success, true);
  assert.equal(createProductSchema.safeParse({ ...alta, soloPara: 'esteban@' }).success, false);
  assert.equal(createProductSchema.safeParse(alta).success, true, 'sin soloPara, como siempre');
  assert.equal(updateProductSchema.safeParse({ soloPara: '' }).success, true, 'vaciar es ponerlo a la venta');
});

test('el grupo guarda la lista normalizada, y vacía como null', async () => {
  empezar();
  await productService.create({ code: 'OTRO', name: 'Otro', priceCents: 100, durationDays: 90, soloPara: ` ${ESTEBAN.toUpperCase()} ` });
  assert.equal(base.ultimoPlan.soloPara, ESTEBAN);

  await productService.update('INFORME_ESTUDIANTIL', { soloPara: '' });
  assert.equal(base.ultimoPlan.soloPara, null);

  await productService.update('INFORME_ESTUDIANTIL', { name: 'Solo el nombre' });
  assert.ok(!('soloPara' in base.ultimaEdicion), 'editar otra cosa no toca la lista');
});
