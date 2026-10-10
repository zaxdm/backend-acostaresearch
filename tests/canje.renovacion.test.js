'use strict';

/**
 * Canjear un código de un producto que ya se tiene.
 *
 * Lo que se prueba: que alarga la licencia que hay en vez de emitir otra —el
 * comprador se quedaba con dos conectores del mismo método—, que cuenta los
 * días desde donde toca, que no devuelve una URL nueva, que el cobro cuelga de
 * la licencia de siempre y que una revocada no se resucita. La base y el correo
 * se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const PLAN = {
  id: 'plan-metodo',
  code: 'METODO_9_SKILLS',
  name: 'Método de tesis · 9 capítulos',
  priceCents: 15900,
  durationDays: 90,
};

/** La licencia que ya tiene de ese producto, o null. Se cambia en cada prueba. */
let vigente = null;
/** Con qué se buscó, para comprobar que una revocada queda fuera. */
let busqueda = null;
const correos = [];

sustituir('../src/lib/prisma', {
  plan: { findFirst: async ({ where }) => (where.kind === 'DOCUMENTO' ? null : PLAN) },
  user: { findUnique: async () => ({ email: 'ana@example.com', firstName: 'Ana' }) },
  license: {
    findFirst: async (args) => {
      busqueda = args;
      return vigente;
    },
  },
});
sustituir('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    correos.push(mensaje);
  },
});
sustituir('../src/lib/notify', { avisarAlAdmin: () => {} });

const hecho = { alargadas: [], emitidas: [], pagos: [], premios: [], disponible: true };

sustituir('../src/modules/licensing/license.repository', {
  findCodeByHash: async () => registro,
  extend: async (id, cambios) => {
    hecho.alargadas.push({ id, ...cambios });
    return { id, productCode: 'METODO_9_SKILLS', status: 'ACTIVE', expiresAt: cambios.expiresAt };
  },
  async redeemCon({ entregar, pago }) {
    if (!hecho.disponible) return null;
    const { fila, enlace } = await entregar({});
    if (pago) hecho.pagos.push({ ...pago, ...enlace });
    return fila;
  },
  redeem: async ({ datosLicencia, pago }) => {
    hecho.emitidas.push(datosLicencia);
    if (pago) hecho.pagos.push(pago);
    return { id: 'lic-nueva', ...datosLicencia };
  },
});
sustituir('../src/modules/referidos/referidos.service', {
  premiarCompra: (datos) => hecho.premios.push(datos),
});

const licenseService = require('../src/modules/licensing/license.service');

let registro = null;

function empezar(extra = {}) {
  registro = {
    id: 'codigo-1',
    productCode: 'METODO_9_SKILLS',
    status: 'AVAILABLE',
    paymentMethod: 'YAPE',
    paymentRef: 'OP-1',
    amountCents: 15900,
    durationDays: null,
    expiresAt: null,
    createdById: 'admin-1',
    createdAt: new Date(),
    ...extra,
  };
  vigente = null;
  busqueda = null;
  correos.length = 0;
  Object.assign(hecho, { alargadas: [], emitidas: [], pagos: [], premios: [], disponible: true });
}

const DIA = 86_400_000;
const canjear = () => licenseService.redeemCode({ userId: 'u1', code: 'acr-aaaa-bbbb-cccc' });
const dias = (fecha) => Math.round((new Date(fecha).getTime() - Date.now()) / DIA);

test('quien ya tiene el producto alarga su licencia, en vez de quedarse con dos', async () => {
  empezar();
  vigente = { id: 'lic-1', expiresAt: new Date(Date.now() + 20 * DIA) };

  const resultado = await canjear();

  assert.equal(resultado.renovada, true);
  assert.equal(resultado.connectorUrl, null, 'su URL de siempre sigue valiendo');
  assert.equal(resultado.license.id, 'lic-1');
  assert.equal(resultado.license.productName, 'Método de tesis · 9 capítulos');
  assert.equal(hecho.emitidas.length, 0, 'no se emite otra licencia');
  assert.equal(hecho.alargadas.length, 1);
  assert.equal(dias(hecho.alargadas[0].expiresAt), 110, 'los 90 días se suman a los 20 que le quedaban');
});

test('con la licencia ya vencida, los días cuentan desde hoy', async () => {
  empezar();
  vigente = { id: 'lic-1', expiresAt: new Date(Date.now() - 40 * DIA) };

  await canjear();

  assert.equal(dias(hecho.alargadas[0].expiresAt), 90);
});

test('manda la duración pactada en el código, y una licencia sin caducidad se queda sin ella', async () => {
  empezar({ durationDays: 180 });
  vigente = { id: 'lic-1', expiresAt: new Date(Date.now() + 10 * DIA) };
  await canjear();
  assert.equal(dias(hecho.alargadas[0].expiresAt), 190);

  empezar();
  vigente = { id: 'lic-1', expiresAt: null };
  await canjear();
  assert.equal(hecho.alargadas[0].expiresAt, null);
});

test('el cobro cuelga de la licencia de siempre y no da premio de referido', async () => {
  empezar();
  vigente = { id: 'lic-1', expiresAt: new Date(Date.now() + 5 * DIA) };

  await canjear();

  assert.equal(hecho.pagos.length, 1);
  assert.equal(hecho.pagos[0].licenseId, 'lic-1');
  assert.equal(hecho.premios.length, 0, 'el premio es por traer a alguien nuevo');
});

test('avisa de la renovación, sin mandar ninguna URL', async () => {
  empezar();
  vigente = { id: 'lic-1', expiresAt: new Date(Date.now() + 5 * DIA) };

  await canjear();
  await new Promise((listo) => setImmediate(listo));

  assert.equal(correos.length, 1);
  assert.equal(correos[0].to, 'ana@example.com');
  assert.doesNotMatch(correos[0].text, /\/mcp\//, 'no hay URL nueva que pegar en Claude');
});

test('una licencia revocada no cuenta: se emite una limpia, con su URL', async () => {
  empezar();

  const resultado = await canjear();

  assert.deepEqual(busqueda.where.status, { not: 'REVOKED' });
  assert.equal(hecho.alargadas.length, 0);
  assert.equal(hecho.emitidas.length, 1);
  assert.ok(resultado.connectorUrl);
  assert.equal(resultado.renovada, undefined);
});

test('si otro canjeó el código un instante antes, no se alarga nada', async () => {
  empezar();
  vigente = { id: 'lic-1', expiresAt: new Date(Date.now() + 5 * DIA) };
  hecho.disponible = false;

  await assert.rejects(canjear(), (error) => error.statusCode === 400);
  assert.equal(hecho.alargadas.length, 0);
});
