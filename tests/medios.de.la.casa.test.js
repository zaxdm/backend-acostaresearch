'use strict';

/**
 * Los medios de pago de la casa, cambiados desde el panel.
 *
 * Lo que se prueba: que sin tocar nada manda el `.env`, que lo guardado en el
 * panel va encima, que un medio apagado deja de ofrecerse en el checkout, que
 * un fallo de la tabla no deja a nadie sin medios de pago, y que el
 * administrador de país no llega a estas rutas. La base se sustituye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let guardadas = [];
let fallaLaTabla = false;
let escrito = null;

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// La configuración de verdad, con los cuatro medios puestos: en el `.env` de
// cada máquina hay unos sí y otros no.
const envDeVerdad = require('../src/config/env');
sustituir('../src/config/env', {
  ...envDeVerdad,
  hotmartEnabled: true,
  culqiEnabled: true,
  yape: { titular: 'Titular del env', numero: '900000000' },
  westernUnion: { activo: true, beneficiario: 'Beneficiario del env', dni: '11111111', ciudad: 'Trujillo' },
});

sustituir('../src/lib/prisma', {
  medioDePago: {
    findMany: async () => {
      if (fallaLaTabla) throw new Error("Table 'medios_de_pago' doesn't exist");
      return guardadas;
    },
    findUnique: async ({ where }) => guardadas.find((f) => f.codigo === where.codigo) ?? null,
    upsert: async (args) => {
      escrito = args;
      return { active: true, updatedAt: new Date(0), ...args.create };
    },
  },
});
sustituir('../src/modules/payments/proof.storage', {});

const medioService = require('../src/modules/payments/medio.service');
const { abiertaAlPais } = require('../src/middlewares/panelDePais');

const delEnv = {
  yape: { titular: 'Titular del env', numero: '900000000', currency: 'PEN' },
  westernUnion: { beneficiario: 'Beneficiario del env', dni: '11111111', ciudad: 'Trujillo', currency: 'USD' },
};

function empezar(filas = []) {
  guardadas = filas;
  fallaLaTabla = false;
  escrito = null;
}

test('sin tocar nada en el panel, manda el .env y todo se ofrece', async () => {
  empezar();

  const checkout = await medioService.paraElCheckout(delEnv);
  assert.equal(checkout.yape.titular, 'Titular del env');
  assert.equal(checkout.yape.activo, true);
  assert.equal(checkout.yape.qrVersion, null);
  assert.equal(checkout.westernUnion.beneficiario, 'Beneficiario del env');
  assert.deepEqual(checkout.apagados, []);

  const panel = await medioService.listar();
  assert.deepEqual(panel.map((m) => m.codigo), ['YAPE', 'WESTERN_UNION', 'HOTMART', 'CULQI']);
  assert.ok(panel.every((m) => m.active));
  // De Hotmart y Culqi solo se enciende y se apaga: sus llaves están en el .env.
  assert.deepEqual(panel.map((m) => m.editable), [true, true, false, false]);
});

test('lo guardado en el panel va encima del .env; lo vacío lo deja como estaba', async () => {
  empezar([
    { codigo: 'YAPE', active: true, titular: 'Titular nuevo', numero: null, qrPath: 'qr.png', updatedAt: new Date(5000) },
    { codigo: 'WESTERN_UNION', active: true, titular: null, numero: null, ciudad: 'Trujillo, Perú' },
  ]);

  const { yape, westernUnion } = await medioService.paraElCheckout(delEnv);
  assert.equal(yape.titular, 'Titular nuevo');
  assert.equal(yape.numero, '900000000');
  assert.equal(yape.qrVersion, 5000);
  assert.equal(westernUnion.beneficiario, 'Beneficiario del env');
  assert.equal(westernUnion.ciudad, 'Trujillo, Perú');
});

test('un medio apagado deja de ofrecerse en el checkout', async () => {
  empezar([
    { codigo: 'YAPE', active: false },
    { codigo: 'WESTERN_UNION', active: false },
    { codigo: 'HOTMART', active: false },
  ]);

  const checkout = await medioService.paraElCheckout(delEnv);
  assert.equal(checkout.yape.activo, false);
  assert.equal(checkout.westernUnion, null);

  const apagados = await medioService.apagados();
  assert.equal(apagados.has('HOTMART'), true);
  assert.equal(apagados.has('CULQI'), false);
});

test('si Western Union no está en el .env, el panel no lo enciende', async () => {
  empezar([{ codigo: 'WESTERN_UNION', active: true, titular: 'Alguien' }]);
  const checkout = await medioService.paraElCheckout({ ...delEnv, westernUnion: null });
  assert.equal(checkout.westernUnion, null);
});

test('si la tabla falla, el checkout sigue con el .env y nada apagado', async () => {
  empezar();
  fallaLaTabla = true;

  const checkout = await medioService.paraElCheckout(delEnv);
  assert.equal(checkout.yape.activo, true);
  assert.equal(checkout.westernUnion.beneficiario, 'Beneficiario del env');
  assert.equal((await medioService.apagados()).size, 0);
});

test('cambiar guarda solo lo que viene, y solo los campos de ese medio', async () => {
  empezar();

  await medioService.cambiar('YAPE', { titular: 'Otro titular', ciudad: 'Lima' }, 'admin-1');
  assert.deepEqual(escrito.update, { titular: 'Otro titular', updatedById: 'admin-1' });

  // De Hotmart solo se guarda si se ofrece: no tiene titular ni número.
  await medioService.cambiar('HOTMART', { active: false, titular: 'No aplica' }, 'admin-1');
  assert.deepEqual(escrito.update, { active: false, updatedById: 'admin-1' });
  assert.equal(escrito.where.codigo, 'HOTMART');
});

test('solo Yape lleva QR', async () => {
  empezar();
  await assert.rejects(() => medioService.guardarQr('HOTMART', Buffer.from('x'), 'admin-1'), /no lleva QR/);
});

test('el administrador de país no llega a los medios de la casa', () => {
  assert.equal(abiertaAlPais('GET', '/payments/manual/medios'), false);
  assert.equal(abiertaAlPais('PATCH', '/payments/manual/medios/YAPE'), false);
  assert.equal(abiertaAlPais('PUT', '/payments/manual/medios/YAPE/qr'), false);
});
