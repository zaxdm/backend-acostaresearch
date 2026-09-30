'use strict';

/**
 * Referidos: quién se puede apuntar con un código y cómo se reparten los días
 * cuando el invitado compra.
 *
 * Lo caro de equivocarse aquí es regalar días de más (dos premios por la misma
 * compra, premiar a quien ya era cliente) o no darlos (perder los del que
 * invitó porque ese día no tenía licencia).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const DIA = 24 * 60 * 60 * 1000;

// ── Base falsa, en memoria ──────────────────────────────────────────────────

const db = { usuarios: [], licencias: [], referidos: [] };

function coincide(fila, where = {}) {
  return Object.entries(where).every(([campo, valor]) => {
    if (campo === 'user') return true; // los invitados de prueba no están en esta base
    if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
      if ('not' in valor) return fila[campo] !== valor.not;
      if ('gt' in valor) return fila[campo] > valor.gt;
      return true;
    }
    return fila[campo] === valor;
  });
}

const prisma = {
  user: {
    findUnique: async ({ where }) =>
      db.usuarios.find((u) => (where.id ? u.id === where.id : u.codigoReferido === where.codigoReferido)) ??
      null,
    updateMany: async ({ where, data }) => {
      const u = db.usuarios.find((x) => x.id === where.id && x.codigoReferido === null);
      if (u) Object.assign(u, data);
      return { count: u ? 1 : 0 };
    },
  },
  license: {
    count: async ({ where }) => db.licencias.filter((l) => coincide(l, where)).length,
    findUnique: async ({ where }) => db.licencias.find((l) => l.id === where.id) ?? null,
    findFirst: async ({ where }) =>
      db.licencias
        .filter((l) => coincide(l, where))
        .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0] ?? null,
    update: async ({ where, data }) => {
      const l = db.licencias.find((x) => x.id === where.id);
      Object.assign(l, data);
      return { id: l.id, expiresAt: l.expiresAt };
    },
  },
  referido: {
    findUnique: async ({ where }) => {
      const r = db.referidos.find((x) => x.invitadoId === where.invitadoId);
      if (!r) return null;
      const invitado = db.usuarios.find((u) => u.id === r.invitadoId);
      const invitador = db.usuarios.find((u) => u.id === r.invitadorId);
      return { ...r, invitado, invitador };
    },
    findMany: async () => db.referidos.filter((r) => r.estado === 'PREMIADO' && r.diasPorAplicar > 0),
    create: async ({ data }) => {
      const fila = { id: `ref-${db.referidos.length + 1}`, estado: 'PENDIENTE', diasPorAplicar: 0, ...data };
      db.referidos.push(fila);
      return fila;
    },
    updateMany: async ({ where, data }) => {
      const r = db.referidos.find(
        (x) =>
          x.id === where.id &&
          (where.estado === undefined || x.estado === where.estado) &&
          (where.diasPorAplicar === undefined || x.diasPorAplicar === where.diasPorAplicar),
      );
      if (r) Object.assign(r, data);
      return { count: r ? 1 : 0 };
    },
    update: async ({ where, data }) => Object.assign(db.referidos.find((x) => x.id === where.id), data),
  },
  $transaction: async (fn) => fn(prisma),
};

sustituir('../src/lib/prisma', prisma);

const correos = [];
sustituir('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    correos.push(mensaje);
    return { messageId: 'x' };
  },
});

const referidos = require('../src/modules/referidos/referidos.service');
const env = require('../src/config/env');

const esperar = () => new Promise((r) => setImmediate(r));

function reiniciar() {
  const dentroDe = (d) => new Date(Date.now() + d * DIA);
  db.usuarios = [
    { id: 'ana', firstName: 'Ana', lastName: 'Pérez', status: 'ACTIVE', codigoReferido: 'ANAK7Q2', email: 'ana@x.com' },
    { id: 'beto', firstName: 'Beto', lastName: 'Ruiz', status: 'ACTIVE', codigoReferido: null, email: 'beto@x.com' },
    { id: 'caro', firstName: 'Caro', lastName: 'Díaz', status: 'ACTIVE', codigoReferido: null, email: 'caro@x.com' },
  ];
  db.licencias = [{ id: 'lic-ana', userId: 'ana', status: 'ACTIVE', expiresAt: dentroDe(20) }];
  db.referidos = [];
  correos.length = 0;
}

// ── Piezas sueltas ──────────────────────────────────────────────────────────

test('el código se escribe como sea: con guiones, espacios o en minúscula', () => {
  assert.equal(referidos.normalizarCodigo(' anak-7q2 '), 'ANAK7Q2');
  assert.equal(referidos.prefijoDe('María José'), 'MARIA');
  assert.equal(referidos.prefijoDe('李'), 'TESIS');
  assert.equal(referidos.nombreCorto({ firstName: 'Ana', lastName: 'Pérez' }), 'Ana P.');
});

test('sumar días: desde la caducidad si no llegó, desde hoy si ya pasó, nada si no caduca', async () => {
  const cliente = { license: { update: async ({ data }) => data } };
  const futura = new Date(Date.now() + 10 * DIA);
  const r1 = await referidos.sumarDias({ id: 'l', expiresAt: futura }, 5, cliente);
  assert.equal(r1.expiresAt.getTime(), futura.getTime() + 5 * DIA);

  const r2 = await referidos.sumarDias({ id: 'l', expiresAt: new Date(Date.now() - 30 * DIA) }, 5, cliente);
  assert.ok(Math.abs(r2.expiresAt.getTime() - (Date.now() + 5 * DIA)) < 1000);

  assert.equal(await referidos.sumarDias({ id: 'l', expiresAt: null }, 5, cliente), null);
});

// ── Apuntarse ───────────────────────────────────────────────────────────────

test('un tesista nuevo se apunta con el código de otro', async () => {
  reiniciar();
  const r = await referidos.apuntarse('beto', 'anak-7q2');
  assert.equal(r.nombre, 'Ana P.');
  assert.equal(db.referidos.length, 1);
  assert.equal(db.referidos[0].invitadorId, 'ana');
});

test('no se puede usar el código propio ni uno que no existe', async () => {
  reiniciar();
  await assert.rejects(referidos.apuntarse('ana', 'ANAK7Q2'), /tu propio código/);
  await assert.rejects(referidos.apuntarse('beto', 'NOEXISTE'), /no existe/);
});

test('quien ya tiene el método no puede apuntarse: el premio es por traer a alguien nuevo', async () => {
  reiniciar();
  db.licencias.push({ id: 'lic-beto', userId: 'beto', status: 'ACTIVE', expiresAt: null });
  await assert.rejects(referidos.apuntarse('beto', 'ANAK7Q2'), /ya lo tienes/);
});

// ── El premio ───────────────────────────────────────────────────────────────

test('al comprar el invitado, los dos reciben sus días y cada uno su correo', async () => {
  reiniciar();
  await referidos.apuntarse('beto', 'ANAK7Q2');
  const antesAna = db.licencias[0].expiresAt.getTime();
  const expiraBeto = new Date(Date.now() + 90 * DIA);
  db.licencias.push({ id: 'lic-beto', userId: 'beto', status: 'ACTIVE', expiresAt: expiraBeto });

  await referidos.premiarCompra({ userId: 'beto', licenseId: 'lic-beto', paymentId: 'pago-1' });
  await esperar();

  assert.equal(db.referidos[0].estado, 'PREMIADO');
  assert.equal(db.licencias[0].expiresAt.getTime(), antesAna + env.REFERIDO_DIAS_INVITADOR * DIA);
  assert.equal(db.licencias[1].expiresAt.getTime(), expiraBeto.getTime() + env.REFERIDO_DIAS_INVITADO * DIA);
  assert.equal(correos.length, 2);
  assert.ok(correos.some((c) => /Beto R\. empezó el método con tu código/.test(c.text)));
});

test('una segunda entrega no vuelve a premiar', async () => {
  reiniciar();
  await referidos.apuntarse('beto', 'ANAK7Q2');
  db.licencias.push({ id: 'lic-beto', userId: 'beto', status: 'ACTIVE', expiresAt: new Date(Date.now() + 90 * DIA) });
  await referidos.premiarCompra({ userId: 'beto', licenseId: 'lic-beto' });
  const trasPrimera = db.licencias[0].expiresAt.getTime();
  await referidos.premiarCompra({ userId: 'beto', licenseId: 'lic-beto' });
  assert.equal(db.licencias[0].expiresAt.getTime(), trasPrimera);
});

test('si el que invitó no tiene licencia, sus días esperan y se suman cuando la tenga', async () => {
  reiniciar();
  db.licencias = []; // Ana ya no tiene el método
  await referidos.apuntarse('caro', 'ANAK7Q2');
  db.licencias.push({ id: 'lic-caro', userId: 'caro', status: 'ACTIVE', expiresAt: new Date(Date.now() + 90 * DIA) });

  await referidos.premiarCompra({ userId: 'caro', licenseId: 'lic-caro' });
  assert.equal(db.referidos[0].diasPorAplicar, env.REFERIDO_DIAS_INVITADOR);

  const renovada = new Date(Date.now() + 30 * DIA);
  db.licencias.push({ id: 'lic-ana-2', userId: 'ana', status: 'ACTIVE', expiresAt: renovada });
  assert.equal(await referidos.aplicarPendientes(), 1);
  assert.equal(db.referidos[0].diasPorAplicar, 0);
  const ana = db.licencias.find((l) => l.id === 'lic-ana-2');
  assert.equal(ana.expiresAt.getTime(), renovada.getTime() + env.REFERIDO_DIAS_INVITADOR * DIA);
});

test('premiar nunca lanza, aunque la base falle', async () => {
  const original = prisma.referido.findUnique;
  prisma.referido.findUnique = async () => {
    throw new Error('base caída');
  };
  assert.equal(await referidos.premiarCompra({ userId: 'beto', licenseId: 'x' }), null);
  prisma.referido.findUnique = original;
});
