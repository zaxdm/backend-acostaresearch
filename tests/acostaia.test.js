'use strict';

/**
 * AcostaIA, el chat propio (4-nov-2026): licencias para sus usuarios.
 *
 * Lo que se prueba: que el alta crea un titular espejo con correo .invalid y le
 * da una licencia del producto pedido; que pedirla otra vez reutiliza el titular
 * y corta la anterior; que un producto que no se vende se rechaza; que revocar
 * respeta el producto; que la ruta exige la clave; que el detector calla las
 * señales de conversaciones solo para estas licencias; y que el mailer no manda
 * nada a direcciones .invalid. La base y el servicio de licencias se sustituyen.
 */

const CLAVE = 'clave-de-prueba-acostaia-0123456789abcdef';
process.env.ACOSTAIA_CLAVE_INTERNA = CLAVE;

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { usuarios: [], licencias: [], revocadas: [], planes: new Set(['METODO_TESIS']) };

function coincideWhere(fila, where) {
  return Object.entries(where).every(([k, v]) => fila[k] === v);
}

sustituir('../src/lib/prisma', {
  user: {
    findUnique: async ({ where }) => estado.usuarios.find((u) => coincideWhere(u, where)) ?? null,
    create: async ({ data }) => {
      const fila = { id: `u${estado.usuarios.length + 1}`, ...data };
      estado.usuarios.push(fila);
      return { id: fila.id };
    },
  },
  license: {
    findMany: async ({ where }) => estado.licencias.filter((l) => coincideWhere(l, where)),
    create: async ({ data }) => {
      const fila = { id: `l${estado.licencias.length + 1}`, status: 'ACTIVE', ...data };
      estado.licencias.push(fila);
      return { id: fila.id };
    },
  },
});

sustituir('../src/modules/licensing/license.service', {
  urlDelConector: (token) => `https://api.ejemplo/mcp/${token}`,
  contratoDelProducto: async (productCode) => ({
    planId: estado.planes.has(productCode) ? 'plan-1' : null,
    topes: {
      callsPerDay: 0,
      callsPerMonth: 0,
      costCentsPerMonth: 500,
      callsLimitTotal: 0,
      costCentsLimitTotal: 0,
      delivery: 'INSTRUCTIONS',
    },
  }),
});

sustituir('../src/modules/licensing/license.repository', {
  setStatus: async (id, datos) => {
    estado.revocadas.push({ id, ...datos });
    Object.assign(estado.licencias.find((l) => l.id === id), { status: datos.status });
  },
});

const acostaiaService = require('../src/modules/acostaia/acostaia.service');
const { analizar } = require('../src/modules/licensing/license.detector');
const { soloDireccionesInvalidas, sendMail } = require('../src/lib/mailer');

test.beforeEach(() => {
  estado.usuarios = [];
  estado.licencias = [];
  estado.revocadas = [];
});

// ── El servicio ─────────────────────────────────────────────────────────────

test('el alta crea un titular espejo con correo .invalid y su licencia', async () => {
  const r = await acostaiaService.crearAcceso({
    acostaiaId: 'usr_12345678',
    productCode: 'METODO_TESIS',
    nombre: 'Ana',
  });

  assert.equal(estado.usuarios.length, 1);
  const titular = estado.usuarios[0];
  assert.equal(titular.acostaiaId, 'usr_12345678');
  assert.match(titular.email, /^acostaia-.+@acostaia\.invalid$/);
  assert.equal(titular.firstName, 'Ana');
  assert.equal(titular.password, undefined);

  assert.equal(estado.licencias.length, 1);
  const licencia = estado.licencias[0];
  assert.equal(licencia.userId, titular.id);
  assert.equal(licencia.productCode, 'METODO_TESIS');
  assert.equal(licencia.expiresAt, null);
  assert.equal(licencia.costCentsPerMonth, 500, 'los topes vienen del plan');
  assert.equal(licencia.delivery, 'INSTRUCTIONS');
  assert.match(r.connectorUrl, /^https:\/\/api\.ejemplo\/mcp\/.{20,}/);
  assert.equal(r.connectorUrl.endsWith(licencia.tokenHint), false, 'el token no es solo la pista');
});

test('pedir el acceso otra vez reutiliza el titular y corta la licencia anterior', async () => {
  const primera = await acostaiaService.crearAcceso({ acostaiaId: 'usr_12345678', productCode: 'METODO_TESIS' });
  const segunda = await acostaiaService.crearAcceso({ acostaiaId: 'usr_12345678', productCode: 'METODO_TESIS' });

  assert.equal(estado.usuarios.length, 1);
  assert.equal(estado.licencias.length, 2);
  assert.notEqual(primera.connectorUrl, segunda.connectorUrl);
  assert.deepEqual(
    estado.revocadas.map((r) => [r.id, r.status, r.origen]),
    [[primera.licenseId, 'REVOKED', 'ACOSTAIA']],
  );
});

test('un producto que no se vende se rechaza sin crear nada', async () => {
  await assert.rejects(
    acostaiaService.crearAcceso({ acostaiaId: 'usr_12345678', productCode: 'NO_EXISTE' }),
    /no existe o no está a la venta/,
  );
  assert.equal(estado.usuarios.length, 0);
  assert.equal(estado.licencias.length, 0);
});

test('revocar corta solo el producto pedido, o todos si no se dice cuál', async () => {
  estado.planes.add('INFORME');
  await acostaiaService.crearAcceso({ acostaiaId: 'usr_12345678', productCode: 'METODO_TESIS' });
  await acostaiaService.crearAcceso({ acostaiaId: 'usr_12345678', productCode: 'INFORME' });

  const uno = await acostaiaService.revocarAcceso({ acostaiaId: 'usr_12345678', productCode: 'INFORME' });
  assert.equal(uno.revocadas, 1);
  assert.equal(estado.licencias.find((l) => l.productCode === 'METODO_TESIS').status, 'ACTIVE');

  const todos = await acostaiaService.revocarAcceso({ acostaiaId: 'usr_12345678' });
  assert.equal(todos.revocadas, 1);
  assert.ok(estado.licencias.every((l) => l.status === 'REVOKED'));

  assert.deepEqual(await acostaiaService.revocarAcceso({ acostaiaId: 'usr_desconocido' }), { revocadas: 0 });
});

// ── La ruta ─────────────────────────────────────────────────────────────────

async function conServidor(fn) {
  const app = express();
  app.use(express.json());
  app.use('/acostaia', require('../src/modules/acostaia/acostaia.routes'));
  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(`http://127.0.0.1:${servidor.address().port}/acostaia`);
  } finally {
    servidor.close();
  }
}

test('la ruta rechaza sin la clave y crea el acceso con ella', async () => {
  await conServidor(async (base) => {
    const cuerpo = JSON.stringify({ acostaiaId: 'usr_12345678', productCode: 'metodo_tesis' });
    const cabeceras = { 'Content-Type': 'application/json' };

    const sinClave = await fetch(`${base}/accesos`, { method: 'POST', headers: cabeceras, body: cuerpo });
    assert.equal(sinClave.status, 401);

    const malClave = await fetch(`${base}/accesos`, {
      method: 'POST',
      headers: { ...cabeceras, Authorization: `Bearer ${CLAVE}x` },
      body: cuerpo,
    });
    assert.equal(malClave.status, 401);
    assert.equal(estado.licencias.length, 0);

    const conClave = await fetch(`${base}/accesos`, {
      method: 'POST',
      headers: { ...cabeceras, Authorization: `Bearer ${CLAVE}` },
      body: cuerpo,
    });
    assert.equal(conClave.status, 201);
    const { data } = await conClave.json();
    assert.equal(data.productCode, 'METODO_TESIS', 'el producto se pasa a mayúsculas');
    assert.match(data.connectorUrl, /\/mcp\//);
  });
});

// ── El detector ─────────────────────────────────────────────────────────────

function chatsDistintos(n, ahora) {
  return Array.from({ length: n }, (_, i) => ({
    createdAt: new Date(ahora.getTime() - (n - i) * 10 * 60 * 1000),
    sessionId: `chat-${i}`,
    promptHash: `h${i}`,
    tool: 'redactar',
  }));
}

test('el detector calla las conversaciones solo en las licencias de AcostaIA', () => {
  const ahora = new Date('2026-11-04T15:00:00Z');
  const usos = chatsDistintos(8, ahora);

  const normal = analizar(usos, { ahora });
  assert.ok(normal.senales.some((s) => s.codigo === 'MUCHAS_SESIONES'), 'a un comprador sí se le marca');

  const deAcostaIA = analizar(usos, { ahora, deAcostaIA: true });
  assert.equal(deAcostaIA.senales.length, 0);
  assert.equal(deAcostaIA.nivel, 'NORMAL');
  assert.equal(deAcostaIA.metricas.deAcostaIA, true);
  assert.equal(deAcostaIA.metricas.variasTesis, false, 'no se confunde con varias tesis');
});

// ── El mailer ───────────────────────────────────────────────────────────────

test('no se manda correo cuando todos los destinatarios son .invalid', async () => {
  assert.equal(soloDireccionesInvalidas('acostaia-1@acostaia.invalid'), true);
  assert.equal(soloDireccionesInvalidas(['a@prueba.invalid', 'B@CUENTA.INVALID']), true);
  assert.equal(soloDireccionesInvalidas('Ana <a@acostaia.invalid>'), true);
  assert.equal(soloDireccionesInvalidas('a@acostaia.invalid, ana@gmail.com'), false);
  assert.equal(soloDireccionesInvalidas('ana@gmail.com'), false);
  assert.equal(soloDireccionesInvalidas(''), false);

  const r = await sendMail({ to: 'acostaia-1@acostaia.invalid', subject: 'x', text: 'x' });
  assert.deepEqual(r, { messageId: null, omitido: true });
});
