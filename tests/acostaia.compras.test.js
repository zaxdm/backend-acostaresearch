'use strict';

/**
 * Comprar un método desde Epicuro (7-nov-2026).
 *
 * Lo que se prueba: que la orden y el cobro van por `paymentService` con Culqi
 * (el cobro de siempre) y a nombre de la cuenta con ese correo; que si no hay
 * cuenta se crea una sin contraseña y con el correo verificado; que una cuenta
 * borrada o suspendida no compra; que cobrar no crea cuentas; que la
 * verificación 3-D Secure se devuelve tal cual; y que el cobro devuelve la
 * licencia para vincularla. La base y el servicio de pagos se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { usuarios: [], ordenes: [], cobros: [], borrados: [] };

sustituir('../src/lib/prisma', {
  user: {
    findUnique: async ({ where }) => estado.usuarios.find((u) => u.email === where.email) ?? null,
    create: async ({ data }) => {
      const fila = { id: `u${estado.usuarios.length + 1}`, status: 'ACTIVE', deletedAt: null, ...data };
      estado.usuarios.push(fila);
      return { id: fila.id };
    },
  },
  pendingRegistration: {
    deleteMany: async ({ where }) => estado.borrados.push(where.email),
  },
});

let respuestaCobro = { license: { id: 'L9', productCode: 'METODO_TESIS' } };
sustituir('../src/modules/payments/payment.service', {
  createOrder: async (datos) => {
    estado.ordenes.push(datos);
    return { orderId: 'cq_1', amountCents: 15900, currency: 'PEN', discount: null, plan: { code: datos.planCode } };
  },
  captureOrder: async (datos) => {
    estado.cobros.push(datos);
    return respuestaCobro;
  },
  listProviders: () => [{ code: 'CULQI', publicKey: 'pk_test_x' }],
});

const compras = require('../src/modules/acostaia/acostaia.compras');

test.beforeEach(() => {
  estado.usuarios.length = 0;
  estado.ordenes.length = 0;
  estado.cobros.length = 0;
  estado.borrados.length = 0;
  respuestaCobro = { license: { id: 'L9', productCode: 'METODO_TESIS' } };
});

test('con cuenta: la orden va por Culqi a su nombre; el precio no viaja', async () => {
  estado.usuarios.push({ id: 'u-ana', email: 'ana@gmail.com', status: 'ACTIVE', deletedAt: null });
  const orden = await compras.orden({ email: 'Ana@Gmail.com ', planCode: 'TESIS_360' });
  assert.equal(orden.orderId, 'cq_1');
  assert.deepEqual(estado.ordenes, [{ userId: 'u-ana', planCode: 'TESIS_360', providerCode: 'CULQI', discountCode: undefined }]);
  assert.equal(estado.usuarios.length, 1, 'no crea otra cuenta');
});

test('sin cuenta: se crea sin contraseña y con el correo verificado', async () => {
  await compras.orden({ email: 'nuevo@gmail.com', nombre: 'Luis', apellido: 'Paz', planCode: 'TESIS_360' });
  const creada = estado.usuarios[0];
  assert.equal(creada.email, 'nuevo@gmail.com');
  assert.equal(creada.firstName, 'Luis');
  assert.equal(creada.passwordHash, undefined);
  assert.ok(creada.emailVerifiedAt instanceof Date);
  assert.deepEqual(estado.borrados, ['nuevo@gmail.com']);
  assert.equal(estado.ordenes[0].userId, creada.id);
});

test('una cuenta borrada o suspendida no compra', async () => {
  estado.usuarios.push({ id: 'u-b', email: 'b@gmail.com', status: 'ACTIVE', deletedAt: new Date() });
  await assert.rejects(compras.orden({ email: 'b@gmail.com', planCode: 'X' }), (e) => e.code === 'CUENTA_INACTIVA');
  estado.usuarios.push({ id: 'u-c', email: 'c@gmail.com', status: 'SUSPENDED', deletedAt: null });
  await assert.rejects(compras.orden({ email: 'c@gmail.com', planCode: 'X' }), (e) => e.code === 'CUENTA_INACTIVA');
  assert.equal(estado.ordenes.length, 0);
});

test('cobrar: con su cuenta, el token y devuelve la licencia; no crea cuentas', async () => {
  await assert.rejects(compras.cobrar({ email: 'nadie@gmail.com', orderId: 'cq_1', token: 'tkn_test_a' }));
  assert.equal(estado.usuarios.length, 0);

  estado.usuarios.push({ id: 'u-ana', email: 'ana@gmail.com', status: 'ACTIVE', deletedAt: null });
  const r = await compras.cobrar({ email: 'ana@gmail.com', orderId: 'cq_1', token: 'tkn_test_a' });
  assert.deepEqual(r, { requiresAuthentication: false, alreadyProcessed: false, licenseId: 'L9', productCode: 'METODO_TESIS' });
  assert.equal(estado.cobros[0].userId, 'u-ana');
  assert.equal(estado.cobros[0].providerCode, 'CULQI');
  assert.equal(estado.cobros[0].datosDelCobro.token, 'tkn_test_a');
});

test('3-D Secure: se devuelve que el banco pide verificar, sin licencia', async () => {
  estado.usuarios.push({ id: 'u-ana', email: 'ana@gmail.com', status: 'ACTIVE', deletedAt: null });
  respuestaCobro = { requiresAuthentication: true };
  const r = await compras.cobrar({ email: 'ana@gmail.com', orderId: 'cq_1', token: 'tkn_test_a' });
  assert.deepEqual(r, { requiresAuthentication: true });
});

test('la llave pública de Culqi, o null', () => {
  assert.deepEqual(compras.pasarela(), { publicKey: 'pk_test_x' });
});
