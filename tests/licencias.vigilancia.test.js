'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * La vigilancia que revoca licencias compartidas: avisar primero, revocar a la
 * segunda.
 *
 * El caso real, del 13 de septiembre de 2026: una prueba abrió nueve
 * conversaciones con la licencia de un tesista y la vigilancia la revocó. El
 * botón «Reactivar» no la recuperaba: la siguiente pasada volvía a ver las
 * mismas conversaciones —seguían dentro de la ventana de 24 horas— y un aviso
 * de días atrás, y la revocaba otra vez. Se prueba que lo anterior a reactivar
 * no se juzga dos veces, que un aviso muy viejo ya no habilita revocar, y que
 * la regla de siempre sigue funcionando.
 *
 * La base, el correo y el detector se sustituyen: lo que se comprueba es qué
 * decide la vigilancia con lo que encuentra.
 */

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const HORA = 60 * 60 * 1000;
const hace = (horas) => new Date(Date.now() - horas * HORA);

// ── Lo que se sustituye ─────────────────────────────────────────────────────

const estado = { licencia: null, alertas: [], usosDesde: null, correos: [] };

/** Aplica a una fecha las condiciones `gte`, `gt` y `lte` de un `where` de Prisma. */
const cumple = (fecha, cond = {}) =>
  (!cond.gte || fecha >= cond.gte) && (!cond.gt || fecha > cond.gt) && (!cond.lte || fecha <= cond.lte);

const encaja = (alerta, where) =>
  alerta.licenseId === where.licenseId &&
  (!where.kind || alerta.kind === where.kind) &&
  (!where.level || alerta.level === where.level) &&
  (!where.action || alerta.action === where.action) &&
  cumple(alerta.createdAt, where.createdAt);

sustituir('../src/lib/prisma', {
  license: {
    findUnique: async () => estado.licencia,
    update: async ({ data }) => Object.assign(estado.licencia, data),
  },
  licenseUsage: {
    findMany: async ({ where }) => {
      estado.usosDesde = where.createdAt.gte;
      return [];
    },
    count: async () => 0,
  },
  licenseAlert: {
    findFirst: async ({ where }) =>
      estado.alertas
        .filter((a) => encaja(a, where))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    create: async ({ data }) => {
      const alerta = { id: `n${estado.alertas.length}`, action: 'NINGUNA', createdAt: new Date(), ...data };
      estado.alertas.push(alerta);
      return alerta;
    },
    update: async ({ where, data }) => Object.assign(estado.alertas.find((a) => a.id === where.id), data),
    updateMany: async ({ where, data }) => {
      const tocadas = estado.alertas.filter((a) => encaja(a, where));
      tocadas.forEach((a) => Object.assign(a, data));
      return { count: tocadas.length };
    },
  },
});
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });
sustituir('../src/lib/mailer', { sendMail: async (correo) => estado.correos.push(correo) });
sustituir('../src/lib/emailTemplates', {
  licenseAlert: ({ revocada }) => ({ subject: revocada ? 'revocada' : 'aviso', html: '' }),
});

// El detector tiene su propia prueba. Aquí siempre ve la misma sospecha alta:
// la de aquel día.
const NIVELES = { NORMAL: 'NORMAL', ALERTA: 'ALERTA', SOSPECHA_ALTA: 'SOSPECHA_ALTA' };
sustituir('../src/modules/licensing/license.detector', {
  NIVELES,
  analizar: () => ({
    nivel: NIVELES.SOSPECHA_ALTA,
    senales: [
      { codigo: 'MUCHAS_SESIONES', detalle: '9 conversaciones distintas en 24 h.', peso: 'alto' },
      { codigo: 'CONSULTAS_INCOHERENTES', detalle: '5 pares de consultas.', peso: 'alto' },
    ],
  }),
});

const { evaluar } = require('../src/modules/licensing/license.watch');

function empezar({ reactivatedAt = null, alertas = [] } = {}) {
  estado.licencia = {
    id: 'L1',
    status: 'ACTIVE',
    lastCheckedAt: null,
    reactivatedAt,
    user: { email: 'tesista@unitru.edu.pe', firstName: 'Tesista', role: 'USER', trialLinkId: null },
  };
  estado.alertas = alertas.map((a, i) => ({ id: `a${i}`, licenseId: 'L1', ...a }));
  estado.usosDesde = null;
  estado.correos = [];
}

const avisoDeHace = (horas) => ({
  kind: 'SESIONES_SOLAPADAS',
  level: 'SOSPECHA_ALTA',
  action: 'NOTIFICADO',
  createdAt: hace(horas),
});

// ── La regla de siempre ─────────────────────────────────────────────────────

test('con un aviso de hace más de doce horas, a la segunda se revoca', async () => {
  empezar({ alertas: [avisoDeHace(13)] });

  const resultado = await evaluar('L1');

  assert.equal(resultado.revocada, true);
  assert.equal(estado.licencia.status, 'REVOKED');
  assert.equal(estado.alertas[0].action, 'REVOCADO', 'el aviso que la habilitó queda gastado');
  assert.equal(estado.correos.at(-1).subject, 'revocada');
});

test('sin aviso previo no se revoca: se avisa y queda anotado', async () => {
  empezar();

  const resultado = await evaluar('L1');

  assert.notEqual(resultado.revocada, true);
  assert.equal(estado.licencia.status, 'ACTIVE');
  assert.ok(estado.alertas.some((a) => a.action === 'NOTIFICADO'));
  assert.equal(estado.correos.at(-1).subject, 'aviso');
});

// ── Lo que se arregló ───────────────────────────────────────────────────────

test('reactivada: el aviso de antes de reactivar ya no revoca, se vuelve a avisar', async () => {
  const reactivatedAt = hace(0.01);
  empezar({ reactivatedAt, alertas: [avisoDeHace(13)] });

  const resultado = await evaluar('L1');

  assert.notEqual(resultado.revocada, true, 'reactivar tiene que servir para algo');
  assert.equal(estado.licencia.status, 'ACTIVE');
  assert.equal(estado.correos.at(-1).subject, 'aviso');
  // Y se anota una alerta nueva: la de antes no la tapa como «ya avisada».
  assert.ok(estado.alertas.some((a) => a.createdAt >= reactivatedAt && a.action === 'NOTIFICADO'));
});

test('reactivada: el uso anterior a reactivar no se vuelve a juzgar', async () => {
  const reactivatedAt = hace(2);
  empezar({ reactivatedAt });

  await evaluar('L1');

  assert.equal(estado.usosDesde.getTime(), reactivatedAt.getTime());
});

test('sin reactivar, la ventana de uso sigue siendo la de treinta días', async () => {
  empezar();

  await evaluar('L1');

  const dias = (Date.now() - estado.usosDesde.getTime()) / (24 * HORA);
  assert.ok(Math.abs(dias - 30) < 0.01, `ventana de ${dias} días`);
});

test('un aviso de hace más de treinta días ya no sirve para revocar sin avisar', async () => {
  empezar({ alertas: [avisoDeHace(31 * 24)] });

  const resultado = await evaluar('L1');

  assert.notEqual(resultado.revocada, true);
  assert.equal(estado.licencia.status, 'ACTIVE');
  assert.equal(estado.correos.at(-1).subject, 'aviso');
});

test('la licencia del administrador sigue sin vigilarse', async () => {
  empezar({ alertas: [avisoDeHace(13)] });
  estado.licencia.user.role = 'ADMIN';

  assert.equal(await evaluar('L1'), null);
  assert.equal(estado.licencia.status, 'ACTIVE');
});
