'use strict';

/**
 * Billeteras digitales de país: lo que Yape es en Perú, para Ecuador y los
 * demás.
 *
 * Lo que se prueba: de qué columna del plan sale el precio según la moneda,
 * que una apagada no cobra, qué se exige del comprobante, y —lo importante—
 * quién ve y quién aprueba cada comprobante: el de Ecuador solo los de la
 * billetera de Ecuador, la casa solo los de Yape salvo que el dueño cambie de
 * país. Las rutas son las de verdad; la base se sustituye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let cuenta;
let consultas = [];
let filas = {};

const tabla = (nombre) =>
  new Proxy(
    {},
    {
      get: (_objeto, metodo) => async (argumentos) => {
        consultas.push({ tabla: nombre, metodo, argumentos });
        if (nombre === 'user' && metodo === 'findUnique' && argumentos?.select?.sessionVersion) {
          return cuenta;
        }
        if (metodo === 'findMany') return [];
        if (metodo === 'findUnique' || metodo === 'findFirst') return filas[nombre] ?? null;
        if (metodo === 'create' || metodo === 'update') return { id: 'b1', ...argumentos.data };
        return {};
      },
    },
  );

const rutaPrisma = require.resolve('../src/lib/prisma');
require.cache[rutaPrisma] = {
  id: rutaPrisma,
  filename: rutaPrisma,
  loaded: true,
  exports: new Proxy({}, { get: (_objeto, nombre) => tabla(nombre) }),
};

const rutaTokens = require.resolve('../src/shared/utils/tokens');
const tokensDeVerdad = require(rutaTokens);
require.cache[rutaTokens].exports = {
  ...tokensDeVerdad,
  verifyAccessToken: () => ({ sub: cuenta.id, role: cuenta.role, typ: 'access', sessionVersion: 0 }),
};

const express = require('express');
const env = require('../src/config/env');
const errorHandler = require('../src/middlewares/errorHandler');
const { abiertaAlPais } = require('../src/middlewares/panelDePais');
const billeteraService = require('../src/modules/payments/billetera.service');
const paymentRepository = require('../src/modules/payments/payment.repository');
const {
  registrarQuerySchema,
  crearBilleteraSchema,
  cambiarBilleteraSchema,
} = require('../src/modules/payments/manual.schema');

const ID = '11111111-2222-3333-4444-555555555555';
const ADMIN = { id: 'a', role: 'ADMIN', email: 'dueno@example.com', status: 'ACTIVE', sessionVersion: 0, pais: null };
const DE_ECUADOR = { id: 'e', role: 'ADMIN_PAIS', email: 'ec@example.com', status: 'ACTIVE', sessionVersion: 0, pais: 'EC' };

const PLAN = { priceCents: 15900, priceUsdCents: 4900 };
const DESCUENTO = { amountCents: 2000, discountUsdCents: 600 };

// ── El medio ─────────────────────────────────────────────────────────────────

test('una billetera en dólares cobra el precio en dólares del plan, y su rebaja', () => {
  const medio = billeteraService.comoMedio({ id: 'b1', nombre: 'Deuna', pais: 'EC', moneda: 'USD' });
  assert.equal(medio.proveedor, 'BILLETERA');
  assert.equal(medio.moneda, 'USD');
  assert.equal(medio.precio(PLAN), 4900);
  assert.equal(medio.rebaja(DESCUENTO), 600);
  assert.equal(medio.billeteraId, 'b1');
  assert.equal(medio.pais, 'EC');
});

test('una en soles cobra el precio en soles', () => {
  const medio = billeteraService.comoMedio({ id: 'b2', nombre: 'Otra', pais: 'BO', moneda: 'PEN' });
  assert.equal(medio.precio(PLAN), 15900);
  assert.equal(medio.rebaja(DESCUENTO), 2000);
});

test('una billetera apagada o que no existe no cobra', async () => {
  filas = { billetera: { id: 'b1', nombre: 'Deuna', pais: 'EC', moneda: 'USD', active: false } };
  await assert.rejects(billeteraService.medioDe('b1'), (error) => error.statusCode === 409);
  filas = {};
  await assert.rejects(billeteraService.medioDe('b1'), (error) => error.statusCode === 409);
  filas = { billetera: { id: 'b1', nombre: 'Deuna', pais: 'EC', moneda: 'USD', active: true } };
  assert.equal((await billeteraService.medioDe('b1')).nombre, 'Deuna');
  filas = {};
});

// ── Lo que se pide ───────────────────────────────────────────────────────────

test('al pagar por una billetera no se piden los dígitos de Yape: basta el número de operación', () => {
  const pago = registrarQuerySchema.parse({ planCode: 'tesis', billetera: ID, operationCode: 'AB-12 34x' });
  assert.equal(pago.operationCode, 'AB1234x');
  assert.equal(pago.billetera, ID);

  assert.equal(registrarQuerySchema.safeParse({ planCode: 'TESIS', billetera: ID }).success, false);
  assert.equal(registrarQuerySchema.safeParse({ planCode: 'TESIS', billetera: 'deuna', operationCode: '123456' }).success, false);
});

test('Yape sigue pidiendo lo suyo', () => {
  assert.equal(registrarQuerySchema.safeParse({ planCode: 'TESIS', operationCode: 'AB1234' }).success, false);
  assert.equal(registrarQuerySchema.parse({ planCode: 'TESIS', operationCode: '123 456' }).operationCode, '123456');
  assert.equal(
    registrarQuerySchema.safeParse({ planCode: 'TESIS', metodo: 'WESTERN_UNION', operationCode: '123456' }).success,
    false,
  );
});

test('el alta pide país de dos letras y moneda PEN o USD; al editar no se cambian', () => {
  const alta = { nombre: 'Deuna', pais: 'ec', moneda: 'USD', titular: 'Ana Paz', numero: '0991234567' };
  assert.equal(crearBilleteraSchema.parse(alta).pais, 'EC');
  assert.equal(crearBilleteraSchema.safeParse({ ...alta, moneda: 'COP' }).success, false);
  assert.equal(crearBilleteraSchema.safeParse({ ...alta, pais: 'Ecuador' }).success, false);

  const cambio = cambiarBilleteraSchema.parse({ active: false, pais: 'CO', moneda: 'PEN' });
  assert.deepEqual(cambio, { active: false });
});

// ── Quién ve qué ─────────────────────────────────────────────────────────────

test('la bandeja de un país son los pagos de su billetera; sin país, la de la casa', () => {
  assert.deepEqual(paymentRepository.deLaBandeja('EC'), { billetera: { pais: 'EC' } });
  assert.deepEqual(paymentRepository.deLaBandeja(null), { billeteraId: null });
  assert.deepEqual(paymentRepository.deLaBandeja(undefined), { billeteraId: null });
});

test('los cobros de un país incluyen los pagados por su billetera', () => {
  assert.deepEqual(paymentRepository.delPais('EC').OR, [
    { user: { pais: 'EC' } },
    { discountCode: { pais: 'EC' } },
    { billetera: { pais: 'EC' } },
  ]);
  assert.equal(paymentRepository.delPais(null).billeteraId, null);
  assert.deepEqual(paymentRepository.delPais(undefined), {});
});

test('el catálogo de billeteras es solo del dueño; la bandeja sí se le abre al de país', () => {
  assert.equal(abiertaAlPais('GET', '/payments/manual/billeteras'), false);
  assert.equal(abiertaAlPais('POST', '/payments/manual/billeteras'), false);
  assert.equal(abiertaAlPais('PATCH', `/payments/manual/billeteras/${ID}`), false);
  assert.equal(abiertaAlPais('GET', '/payments/manual/pending'), true);
  assert.equal(abiertaAlPais('POST', `/payments/manual/${ID}/approve`), true);
  assert.equal(abiertaAlPais('POST', `/payments/manual/${ID}/reject`), true);
});

let servidor;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(`${env.API_PREFIX}/payments`, require('../src/modules/payments/payment.routes'));
  app.use(errorHandler);
  servidor = http.createServer(app);
  await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
  base = `http://127.0.0.1:${servidor.address().port}${env.API_PREFIX}`;
});

test.after(() => servidor?.close());

async function pedir(usuario, metodo, ruta, cuerpo) {
  cuenta = usuario;
  consultas = [];
  const respuesta = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { authorization: 'Bearer firmado', 'content-type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return respuesta.status;
}

const donde = (metodo = 'findMany') =>
  consultas.find((c) => c.tabla === 'payment' && c.metodo === metodo)?.argumentos?.where;

test('al de Ecuador le llegan solo los comprobantes de la billetera de Ecuador', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/payments/manual/pending?pais=ninguno'), 200);
  assert.equal(donde().status, 'IN_REVIEW');
  assert.deepEqual(donde().billetera, { pais: 'EC' });

  assert.equal(await pedir(DE_ECUADOR, 'GET', '/payments/manual/history'), 200);
  assert.deepEqual(donde().billetera, { pais: 'EC' });
  assert.ok(donde().provider.in.includes('BILLETERA'));
});

test('al dueño le llegan los de Yape; los de un país, solo si cambia de país', async () => {
  assert.equal(await pedir(ADMIN, 'GET', '/payments/manual/pending'), 200);
  assert.equal(donde().billeteraId, null);
  assert.equal('billetera' in donde(), false);

  await pedir(ADMIN, 'GET', '/payments/manual/pending?pais=ninguno');
  assert.equal(donde().billeteraId, null);

  await pedir(ADMIN, 'GET', '/payments/manual/pending?pais=EC');
  assert.deepEqual(donde().billetera, { pais: 'EC' });

  await pedir(ADMIN, 'GET', '/payments/manual/history?pais=EC');
  assert.deepEqual(donde().billetera, { pais: 'EC' });
});

test('el de Ecuador no ve, no aprueba ni rechaza un Yape ni lo de otro país', async () => {
  filas = {}; // la búsqueda «¿es de mi bandeja?» no encuentra nada
  for (const [metodo, ruta, cuerpo] of [
    ['GET', `/payments/manual/${ID}/proof`],
    ['POST', `/payments/manual/${ID}/approve`, {}],
    ['POST', `/payments/manual/${ID}/reject`, { motivo: 'No llegó el dinero a la cuenta.' }],
  ]) {
    assert.equal(await pedir(DE_ECUADOR, metodo, ruta, cuerpo), 404, `${metodo} ${ruta}`);
    assert.deepEqual(donde('findFirst').billetera, { pais: 'EC' }, ruta);
    // Y no llegó a tocar el pago.
    assert.equal(consultas.some((c) => c.tabla === 'payment' && c.metodo !== 'findFirst'), false, ruta);
  }
});

test('el de Ecuador sí llega a uno de su billetera', async () => {
  filas = { payment: { id: ID, status: 'PAID' } };
  assert.equal(await pedir(DE_ECUADOR, 'POST', `/payments/manual/${ID}/approve`, {}), 200);
  filas = {};
});

test('crear y apagar billeteras: el dueño sí, el de país no', async () => {
  const alta = { nombre: 'Deuna', pais: 'EC', moneda: 'USD', titular: 'Ana Paz', numero: '0991234567' };

  assert.equal(await pedir(DE_ECUADOR, 'POST', '/payments/manual/billeteras', alta), 403);
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/payments/manual/billeteras'), 403);
  assert.equal(await pedir(DE_ECUADOR, 'PATCH', `/payments/manual/billeteras/${ID}`, { active: false }), 403);

  assert.equal(await pedir(ADMIN, 'POST', '/payments/manual/billeteras', alta), 201);
  const creada = consultas.find((c) => c.tabla === 'billetera' && c.metodo === 'create');
  assert.equal(creada.argumentos.data.pais, 'EC');
  assert.equal(creada.argumentos.data.createdById, 'a');

  filas = { billetera: { id: ID } };
  assert.equal(await pedir(ADMIN, 'PATCH', `/payments/manual/billeteras/${ID}`, { active: false, pais: 'CO' }), 200);
  const cambio = consultas.find((c) => c.tabla === 'billetera' && c.metodo === 'update');
  assert.deepEqual(cambio.argumentos.data, { active: false });
  filas = {};
});

test('la ruta del QR en el disco no sale nunca: solo si lo tiene y su versión', async () => {
  const fecha = new Date('2026-10-12T20:00:00Z');
  const tabla = require('../src/lib/prisma').billetera;
  const original = tabla.findMany;
  require.cache[rutaPrisma].exports = new Proxy(
    {},
    {
      get: (_o, nombre) =>
        nombre === 'billetera'
          ? {
              findMany: async () => [
                { id: 'b1', nombre: 'Deuna', pais: 'EC', qrPath: '2026-10/qr-b1.png', updatedAt: fecha },
                { id: 'b2', nombre: 'Nequi', pais: 'CO', qrPath: null, updatedAt: fecha },
              ],
            }
          : { findMany: original },
    },
  );
  // El servicio guardó la referencia al cliente de antes: se le pregunta a uno nuevo.
  delete require.cache[require.resolve('../src/modules/payments/billetera.service')];
  const servicio = require('../src/modules/payments/billetera.service');

  const [deuna, nequi] = await servicio.publicas();
  assert.equal('qrPath' in deuna, false);
  assert.equal('updatedAt' in deuna, false);
  assert.equal(deuna.tieneQr, true);
  assert.equal(deuna.qrVersion, fecha.getTime());
  assert.equal(nequi.tieneQr, false);
  assert.equal(nequi.qrVersion, null);
});

test('el QR lo sube solo el dueño, y verlo no pide sesión', async () => {
  assert.equal(abiertaAlPais('PUT', `/payments/manual/billeteras/${ID}/qr`), false);
  assert.equal(await pedir(DE_ECUADOR, 'PUT', `/payments/manual/billeteras/${ID}/qr`), 403);

  // Sin QR guardado: 404, y sin pedir sesión a nadie.
  filas = {};
  const respuesta = await fetch(`${base}/payments/manual/billeteras/${ID}/qr`);
  assert.equal(respuesta.status, 404);

  // Lo que no es una imagen no se guarda.
  filas = { billetera: { id: ID, qrPath: null } };
  cuenta = ADMIN;
  consultas = [];
  const mala = await fetch(`${base}/payments/manual/billeteras/${ID}/qr`, {
    method: 'PUT',
    headers: { authorization: 'Bearer firmado', 'content-type': 'image/png' },
    body: Buffer.from('esto no es una imagen, es texto suelto'),
  });
  assert.equal(mala.status, 415);
  assert.equal(consultas.some((c) => c.tabla === 'billetera' && c.metodo === 'update'), false);
  filas = {};
});

test('quien va a pagar ve las billeteras activas junto a Yape, sin sesión', async () => {
  consultas = [];
  const respuesta = await fetch(`${base}/payments/manual/info`);
  assert.equal(respuesta.status, 200);
  const { data } = await respuesta.json();
  assert.deepEqual(data.billeteras, []);
  assert.ok('yape' in data);
  const lista = consultas.find((c) => c.tabla === 'billetera' && c.metodo === 'findMany');
  assert.deepEqual(lista.argumentos.where, { active: true });
});
