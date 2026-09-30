'use strict';

/**
 * Correos según el avance del tesista: a quién le toca qué, y que no se
 * repitan ni se acumulen.
 *
 * Lo que decide está en funciones puras (`avisosDe`, `elMasImportante`); la
 * pasada entera se prueba con una base falsa para comprobar las reglas que
 * cruzan licencias: uno por persona, la pausa de 3 días y lo ya enviado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const DIA = 24 * 60 * 60 * 1000;
const AHORA = new Date('2026-10-10T15:00:00Z'); // 10:00 en Lima
const hace = (dias) => new Date(AHORA.getTime() - dias * DIA);
const dentroDe = (dias) => new Date(AHORA.getTime() + dias * DIA);

// ── Base falsa ──────────────────────────────────────────────────────────────

const base = { licencias: [], proyectos: [], enviados: [], creados: [] };
const correos = [];

sustituir('../src/lib/prisma', {
  license: { findMany: async () => base.licencias },
  project: { findMany: async () => base.proyectos },
  skill: { findMany: async () => [{ code: 'marco', displayName: 'Marco teórico' }] },
  plan: { findMany: async () => [{ productCode: 'METODO_9_SKILLS', name: 'Método de tesis' }] },
  avisoAvance: {
    findMany: async () => base.enviados,
    create: async ({ data }) => {
      base.creados.push(data);
      return data;
    },
  },
  referido: { findMany: async () => [] },
});

sustituir('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    correos.push(mensaje);
    return { messageId: 'x' };
  },
});

const avisos = require('../src/modules/avisos/avisos.service');
const { avisosDe, elMasImportante, firmaDeBaja, firmaValida } = avisos;

function licencia(extra = {}) {
  return {
    id: 'lic-1',
    userId: 'u-1',
    productCode: 'METODO_9_SKILLS',
    callsTotal: 0,
    lastUsedAt: null,
    createdAt: hace(10),
    expiresAt: dentroDe(60),
    user: { email: 'ana@example.com', firstName: 'Ana' },
    ...extra,
  };
}

function reiniciar() {
  base.licencias = [];
  base.proyectos = [];
  base.enviados = [];
  base.creados = [];
  correos.length = 0;
}

// ── Qué le toca a cada licencia ─────────────────────────────────────────────

test('sin conectar: a los 3 días sí, a las 24 horas no, al mes ya no se insiste', () => {
  const tipos = (dias) =>
    avisosDe(licencia({ createdAt: hace(dias) }), null, AHORA).map((a) => a.tipo);

  assert.deepEqual(tipos(1), []);
  assert.deepEqual(tipos(3), ['SIN_CONECTAR']);
  assert.deepEqual(tipos(31), []);
});

test('sin avanzar: la clave lleva el día del último uso, para que un nuevo parón sea otro aviso', () => {
  const [aviso] = avisosDe(
    licencia({ callsTotal: 40, lastUsedAt: hace(8) }),
    { id: 'p', plantillaAt: new Date(), avanza: true, fase: 'Marco teórico' },
    AHORA,
  );
  assert.equal(aviso.tipo, 'SIN_AVANZAR');
  assert.equal(aviso.clave, `lic-1:${hace(8).toISOString().slice(0, 10)}`);
  assert.equal(aviso.datos.fase, 'Marco teórico');
  assert.equal(aviso.datos.dias, 8);
});

test('sin avanzar no se manda al humanizador suelto: no tiene fases', () => {
  const avisosDelHumanizador = avisosDe(
    licencia({ productCode: 'HUMANIZADOR_ACADEMICO', callsTotal: 5, lastUsedAt: hace(9) }),
    null,
    AHORA,
  );
  assert.deepEqual(avisosDelHumanizador, []);
});

test('falta formato: solo si ya avanza, no en artículos y no si ya lo subió', () => {
  const avanza = { id: 'proy-1', plantillaAt: null, avanza: true, fase: null };
  const conUso = { callsTotal: 3, lastUsedAt: hace(1) };

  assert.deepEqual(
    avisosDe(licencia(conUso), avanza, AHORA).map((a) => a.tipo),
    ['FALTA_FORMATO'],
  );
  assert.deepEqual(avisosDe(licencia(conUso), { ...avanza, avanza: false }, AHORA), []);
  assert.deepEqual(avisosDe(licencia(conUso), { ...avanza, plantillaAt: new Date() }, AHORA), []);
  assert.deepEqual(
    avisosDe(licencia({ ...conUso, productCode: 'ARTICULO_CIENTIFICO' }), avanza, AHORA),
    [],
  );
});

test('vence pronto: dentro de 5 días, con la fecha en la clave', () => {
  const [aviso] = avisosDe(
    licencia({ callsTotal: 3, lastUsedAt: hace(1), expiresAt: dentroDe(4.5) }),
    null,
    AHORA,
  );
  assert.equal(aviso.tipo, 'VENCE_PRONTO');
  assert.equal(aviso.datos.dias, 5);
  assert.match(aviso.clave, /^lic-1:\d{4}-\d{2}-\d{2}$/);
});

test('si tocan varios, sale el más importante', () => {
  const elegido = elMasImportante([
    { tipo: 'FALTA_FORMATO' },
    { tipo: 'SIN_CONECTAR' },
    { tipo: 'VENCE_PRONTO' },
  ]);
  assert.equal(elegido.tipo, 'VENCE_PRONTO');
  assert.equal(elMasImportante([]), null);
});

test('la firma de la baja vale para su cuenta y no para otra', () => {
  const firma = firmaDeBaja('11111111-1111-1111-1111-111111111111');
  assert.ok(firmaValida('11111111-1111-1111-1111-111111111111', firma));
  assert.ok(!firmaValida('22222222-2222-2222-2222-222222222222', firma));
  assert.ok(!firmaValida('11111111-1111-1111-1111-111111111111', 'otra-cosa'));
});

// ── La pasada del día ───────────────────────────────────────────────────────

test('manda uno por persona, apunta lo enviado y lleva la cabecera de baja', async () => {
  reiniciar();
  base.licencias = [
    licencia(),
    // La misma persona con otra licencia que vence: gana la caducidad.
    licencia({ id: 'lic-2', callsTotal: 9, lastUsedAt: hace(1), expiresAt: dentroDe(2) }),
    licencia({ id: 'lic-3', userId: 'u-2', user: { email: 'beto@example.com', firstName: 'Beto' } }),
  ];

  const { enviados } = await avisos.enviarDelDia({ ahora: AHORA });

  assert.equal(enviados, 2);
  assert.deepEqual(
    base.creados.map((c) => [c.userId, c.tipo]),
    [
      ['u-1', 'VENCE_PRONTO'],
      ['u-2', 'SIN_CONECTAR'],
    ],
  );
  assert.match(correos[0].subject, /termina en 2 días/);
  assert.match(correos[0].headers['List-Unsubscribe'], /\/avisos\/baja\?u=u-1&t=/);
  assert.match(correos[1].text, /empecemos mi tesis/);
});

test('no repite lo ya enviado ni escribe a quien recibió algo hace menos de 3 días', async () => {
  reiniciar();
  base.licencias = [
    licencia(),
    licencia({ id: 'lic-3', userId: 'u-2', user: { email: 'beto@example.com', firstName: 'Beto' } }),
  ];
  base.enviados = [
    { userId: 'u-1', tipo: 'SIN_CONECTAR', clave: 'lic-1', enviadoAt: hace(6) },
    { userId: 'u-2', tipo: 'FALTA_FORMATO', clave: 'otro', enviadoAt: hace(1) },
  ];

  const { enviados, lista } = await avisos.enviarDelDia({ ahora: AHORA });
  assert.equal(enviados, 0);
  assert.deepEqual(lista, []);
});

test('--ver no manda nada', async () => {
  reiniciar();
  base.licencias = [licencia()];
  const { lista } = await avisos.enviarDelDia({ ahora: AHORA, soloVer: true });
  assert.deepEqual(lista, [
    { email: 'ana@example.com', tipo: 'SIN_CONECTAR', producto: 'METODO_9_SKILLS' },
  ]);
  assert.equal(correos.length, 0);
  assert.equal(base.creados.length, 0);
});

test('la pasada programada sale una vez al día y no antes de las 9 de Lima', async () => {
  reiniciar();
  const estado = { ultimoDia: null };
  const temprano = new Date('2026-10-10T12:00:00Z'); // 07:00 en Lima
  assert.equal(await avisos.pasadaProgramada(estado, temprano), null);

  const primera = await avisos.pasadaProgramada(estado, AHORA);
  assert.ok(primera);
  assert.equal(await avisos.pasadaProgramada(estado, new Date(AHORA.getTime() + 3600_000)), null);
});
