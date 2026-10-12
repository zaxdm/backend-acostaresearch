'use strict';

/**
 * El administrador de país: qué rutas del panel se le abren y que en las que se
 * le abren solo ve lo de su país.
 *
 * La segunda mitad levanta las rutas de verdad —licencias, pagos, descuentos y
 * enlaces de prueba— con una base simulada que apunta cada consulta, para mirar
 * el `where` que acaba llegando a Prisma y no solo la función que lo arma.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ── La base y la sesión, simuladas ───────────────────────────────────────────
let cuenta;
let consultas = [];
/** Lo que devuelve `findUnique`/`findFirst` de cada tabla en la prueba en curso. */
let filas = {};
/** Y lo que devuelve su `findMany`. */
let listas = {};

const tabla = (nombre) =>
  new Proxy(
    {},
    {
      get: (_objeto, metodo) => async (argumentos) => {
        consultas.push({ tabla: nombre, metodo, argumentos });
        if (nombre === 'user' && metodo === 'findUnique' && argumentos?.select?.sessionVersion) {
          return cuenta;
        }
        if (metodo === 'findMany') return listas[nombre] ?? [];
        if (metodo === 'groupBy') return [];
        if (metodo === 'count') return 0;
        if (metodo === 'findUnique' || metodo === 'findFirst') return filas[nombre] ?? null;
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
  verifyAccessToken: () => ({
    sub: cuenta.id,
    role: cuenta.role,
    typ: 'access',
    sessionVersion: 0,
  }),
};

const express = require('express');
const env = require('../src/config/env');
const { ROLES } = require('../src/config/constants');
const authorize = require('../src/middlewares/authorize');
const errorHandler = require('../src/middlewares/errorHandler');
const {
  ABIERTAS,
  abiertaAlPais,
  alcanceDe,
  dondePais,
  exigirPais,
  normalizarPais,
} = require('../src/middlewares/panelDePais');
const { createAdminSchema } = require('../src/modules/users/user.schema');

const ID = '11111111-2222-3333-4444-555555555555';

const ADMIN = { id: 'a', role: 'ADMIN', email: 'dueno@example.com', status: 'ACTIVE', sessionVersion: 0, pais: null };
const DE_ECUADOR = { id: 'e', role: 'ADMIN_PAIS', email: 'ec@example.com', status: 'ACTIVE', sessionVersion: 0, pais: 'EC' };

// ── La lista de rutas abiertas ───────────────────────────────────────────────

test('lo suyo está abierto: códigos, licencias, descuentos y enlaces de prueba', () => {
  assert.equal(abiertaAlPais('GET', '/licenses/codes'), true);
  assert.equal(abiertaAlPais('POST', '/licenses/codes'), true);
  assert.equal(abiertaAlPais('GET', '/licenses'), true);
  assert.equal(abiertaAlPais('GET', `/licenses/${ID}`), true);
  assert.equal(abiertaAlPais('POST', `/licenses/${ID}/revoke`), true);
  assert.equal(abiertaAlPais('GET', '/billing/discounts'), true);
  assert.equal(abiertaAlPais('PATCH', `/billing/discounts/${ID}`), true);
  assert.equal(abiertaAlPais('GET', '/pruebas'), true);
  assert.equal(abiertaAlPais('GET', '/users'), true);
});

test('lo que no es suyo está cerrado: sorteos, WhatsApp, bibliografía, universidades, ventas', () => {
  assert.equal(abiertaAlPais('GET', '/sorteos'), false);
  assert.equal(abiertaAlPais('GET', '/whatsapp/conversaciones'), false);
  assert.equal(abiertaAlPais('GET', '/referencias'), false);
  assert.equal(abiertaAlPais('GET', '/grupos'), false);
  assert.equal(abiertaAlPais('GET', '/ventas/meses'), false);
  assert.equal(abiertaAlPais('GET', '/referidos'), false);
});

test('el catálogo, los videos y las guías se miran pero no se tocan', () => {
  assert.equal(abiertaAlPais('GET', '/billing/products'), true);
  assert.equal(abiertaAlPais('POST', '/billing/products'), false);
  assert.equal(abiertaAlPais('PATCH', '/billing/products/TESIS'), false);
  assert.equal(abiertaAlPais('GET', '/skills'), true);
  assert.equal(abiertaAlPais('POST', '/skills'), false);
  assert.equal(abiertaAlPais('PATCH', `/skills/${ID}`), false);
  assert.equal(abiertaAlPais('GET', '/tutoriales/todos'), true);
  assert.equal(abiertaAlPais('PUT', '/tutoriales/orden'), false);
  assert.equal(abiertaAlPais('GET', '/guias/todas'), true);
  assert.equal(abiertaAlPais('DELETE', `/guias/${ID}`), false);
});

test('«:id» no abre de rebote las rutas con nombre que cuelgan al lado', () => {
  assert.equal(abiertaAlPais('GET', '/licenses/review'), false);
  assert.equal(abiertaAlPais('GET', '/licenses/alerts'), true);
  assert.equal(abiertaAlPais('DELETE', `/licenses/codes/${ID}/permanent`), false);
  assert.equal(abiertaAlPais('DELETE', `/licenses/${ID}`), false);
  assert.equal(abiertaAlPais('POST', `/licenses/${ID}/product`), false);
  assert.equal(abiertaAlPais('POST', `/licenses/${ID}/email`), false);
  assert.equal(abiertaAlPais('POST', `/licenses/${ID}/duracion`), false);
});

test('mira los cobros de sus clientes pero no aprueba ni borra ninguno', () => {
  assert.equal(abiertaAlPais('GET', '/payments/recent'), true);
  assert.equal(abiertaAlPais('GET', '/payments/manual/pending'), true);
  assert.equal(abiertaAlPais('POST', `/payments/manual/${ID}/approve`), false);
  assert.equal(abiertaAlPais('POST', `/payments/manual/${ID}/reject`), false);
  assert.equal(abiertaAlPais('DELETE', `/payments/${ID}`), false);
  assert.equal(abiertaAlPais('POST', '/billing/packs'), false);
});

test('no crea administradores, no suspende cuentas y no responde ni modera', () => {
  assert.equal(abiertaAlPais('POST', '/users/admins'), false);
  assert.equal(abiertaAlPais('PATCH', `/users/${ID}/status`), false);
  assert.equal(abiertaAlPais('POST', '/reclamos/12/respuesta'), false);
  assert.equal(abiertaAlPais('PATCH', `/resenas/panel/${ID}`), false);
  assert.equal(abiertaAlPais('POST', '/resenas/panel'), false);
});

test('la lista solo tiene lecturas fuera de lo que es suyo', () => {
  const escrituras = ABIERTAS.filter((entrada) => !entrada.startsWith('GET '));
  for (const entrada of escrituras) {
    assert.match(entrada, / \/(licenses|billing\/discounts|pruebas)/, entrada);
  }
});

// ── El alcance ───────────────────────────────────────────────────────────────

test('al administrador de país se le aplica su país, pida lo que pida', () => {
  assert.deepEqual(alcanceDe(DE_ECUADOR, { pais: 'PE' }), { dePais: true, pais: 'EC', filtro: 'EC' });
  assert.deepEqual(alcanceDe(DE_ECUADOR, { pais: 'ninguno' }), { dePais: true, pais: 'EC', filtro: 'EC' });
});

test('el dueño lo ve todo, un país o solo lo de la casa', () => {
  assert.equal(alcanceDe(ADMIN, {}).filtro, undefined);
  assert.equal(alcanceDe(ADMIN, { pais: 'ec' }).filtro, 'EC');
  assert.equal(alcanceDe(ADMIN, { pais: 'ninguno' }).filtro, null);
  assert.equal(alcanceDe(ADMIN, { pais: 'Ecuador' }).filtro, undefined);
  assert.deepEqual(dondePais(alcanceDe(ADMIN, {})), {});
  assert.deepEqual(dondePais(alcanceDe(ADMIN, { pais: 'EC' })), { pais: 'EC' });
  assert.deepEqual(dondePais(alcanceDe(ADMIN, { pais: 'ninguno' })), { pais: null });
});

test('un registro de otro país «no existe»; al dueño no se le corta nada', () => {
  const alcance = alcanceDe(DE_ECUADOR);
  assert.doesNotThrow(() => exigirPais(alcance, 'EC'));
  assert.throws(() => exigirPais(alcance, 'CO'), { statusCode: 404 });
  assert.throws(() => exigirPais(alcance, null), { statusCode: 404 });
  assert.throws(() => exigirPais(alcance, undefined), { statusCode: 404 });
  assert.doesNotThrow(() => exigirPais(alcanceDe(ADMIN, { pais: 'EC' }), 'CO'));
});

test('un país es su código de dos letras', () => {
  assert.equal(normalizarPais(' ec '), 'EC');
  assert.equal(normalizarPais('ECU'), null);
  assert.equal(normalizarPais(593), null);
  assert.equal(createAdminSchema.parse({ firstName: 'Ana', lastName: 'Paz', email: 'a@b.co', pais: 'ec' }).pais, 'EC');
  assert.equal('pais' in createAdminSchema.parse({ firstName: 'Ana', lastName: 'Paz', email: 'a@b.co' }), false);
  assert.equal(createAdminSchema.safeParse({ firstName: 'Ana', lastName: 'Paz', email: 'a@b.co', pais: 'Ecuador' }).success, false);
});

// ── La guarda ────────────────────────────────────────────────────────────────

function pasar(usuario, { metodo = 'GET', ruta, consulta = {}, roles = [ROLES.ADMIN] }) {
  const req = { user: usuario, method: metodo, baseUrl: env.API_PREFIX, path: ruta, query: consulta };
  let fallo;
  authorize(...roles)(req, {}, (error) => {
    fallo = error;
  });
  return { fallo, req };
}

test('la guarda deja al de país solo en lo abierto y le pone su alcance', () => {
  const abierta = pasar(DE_ECUADOR, { ruta: '/licenses', consulta: { pais: 'PE' } });
  assert.equal(abierta.fallo, undefined);
  assert.equal(abierta.req.alcance.filtro, 'EC');

  assert.equal(pasar(DE_ECUADOR, { ruta: '/sorteos' }).fallo.statusCode, 403);
  assert.equal(pasar(DE_ECUADOR, { ruta: '/licenses/review' }).fallo.statusCode, 403);
  assert.equal(pasar(DE_ECUADOR, { metodo: 'POST', ruta: '/users/admins' }).fallo.statusCode, 403);
});

test('un administrador de país sin país no ve nada', () => {
  assert.equal(pasar({ ...DE_ECUADOR, pais: null }, { ruta: '/licenses' }).fallo.statusCode, 403);
});

test('el dueño pasa por todo, y un cliente por nada', () => {
  const todo = pasar(ADMIN, { ruta: '/sorteos' });
  assert.equal(todo.fallo, undefined);
  assert.equal(todo.req.alcance.filtro, undefined);
  assert.equal(pasar(ADMIN, { ruta: '/licenses', consulta: { pais: 'EC' } }).req.alcance.filtro, 'EC');
  assert.equal(pasar({ ...ADMIN, role: 'USER' }, { ruta: '/licenses' }).fallo.statusCode, 403);
});

test('el rol de país no vale donde se pide otro rol', () => {
  assert.equal(pasar(DE_ECUADOR, { ruta: '/licenses', roles: [ROLES.EDITOR] }).fallo.statusCode, 403);
});

// ── Las rutas de verdad ──────────────────────────────────────────────────────

let servidor;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(`${env.API_PREFIX}/licenses`, require('../src/modules/licensing/license.routes'));
  app.use(`${env.API_PREFIX}/payments`, require('../src/modules/payments/payment.routes'));
  app.use(`${env.API_PREFIX}/billing`, require('../src/modules/billing/billing.routes'));
  app.use(`${env.API_PREFIX}/pruebas`, require('../src/modules/trials/trial.routes'));
  app.use(`${env.API_PREFIX}/resenas`, require('../src/modules/resenas/resena.routes'));
  app.use(`${env.API_PREFIX}/embudo`, require('../src/modules/embudo/embudo.routes'));
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

/** El `where` de la primera consulta a esa tabla, sin contar la de la sesión. */
const dondeDe = (nombre, metodo = 'findMany') =>
  consultas.find((consulta) => consulta.tabla === nombre && consulta.metodo === metodo)?.argumentos
    ?.where;

test('licencias: al de país solo las de sus clientes, aunque pida otro país', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/licenses?pais=PE'), 200);
  assert.equal(dondeDe('license').user.pais, 'EC');
});

test('licencias: el dueño todas, un país o solo las de la casa', async () => {
  assert.equal(await pedir(ADMIN, 'GET', '/licenses'), 200);
  assert.equal('pais' in dondeDe('license').user, false);

  await pedir(ADMIN, 'GET', '/licenses?pais=EC');
  assert.equal(dondeDe('license').user.pais, 'EC');

  await pedir(ADMIN, 'GET', '/licenses?pais=ninguno');
  assert.equal(dondeDe('license').user.pais, null);
});

test('códigos y alertas: filtrados por su país', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/licenses/codes'), 200);
  assert.equal(dondeDe('activationCode').pais, 'EC');

  assert.equal(await pedir(DE_ECUADOR, 'GET', '/licenses/alerts'), 200);
  assert.equal(dondeDe('licenseAlert').license.user.pais, 'EC');

  await pedir(ADMIN, 'GET', '/licenses/alerts');
  assert.equal('license' in dondeDe('licenseAlert'), false);
});

test('la ficha y la revocación de una licencia de otro país: no existe', async () => {
  filas = { license: { user: { pais: 'CO' } } };
  assert.equal(await pedir(DE_ECUADOR, 'GET', `/licenses/${ID}`), 404);
  assert.equal(await pedir(DE_ECUADOR, 'POST', `/licenses/${ID}/revoke`, {}), 404);
  assert.equal(await pedir(DE_ECUADOR, 'POST', `/licenses/${ID}/reactivate`), 404);

  // Y la de un cliente sin etiqueta, que es de la casa, tampoco.
  filas = { license: { user: { pais: null } } };
  assert.equal(await pedir(DE_ECUADOR, 'GET', `/licenses/${ID}`), 404);
  filas = {};
});

test('lo cerrado responde 403 antes de tocar la base', async () => {
  for (const [metodo, ruta] of [
    ['GET', '/licenses/review'],
    ['DELETE', `/licenses/${ID}`],
    ['DELETE', `/licenses/codes/${ID}/permanent`],
    ['POST', `/licenses/${ID}/email`],
    ['POST', `/payments/manual/${ID}/approve`],
    ['DELETE', `/payments/${ID}`],
    ['POST', '/billing/packs'],
    ['POST', '/billing/products'],
    ['GET', '/billing/packs'],
    ['PATCH', `/resenas/panel/${ID}`],
  ]) {
    const cuerpo = metodo === 'GET' ? undefined : {};
    assert.equal(await pedir(DE_ECUADOR, metodo, ruta, cuerpo), 403, `${metodo} ${ruta}`);
    // Solo la lectura de la sesión: nada más llegó a consultarse.
    assert.equal(consultas.length, 1, `${metodo} ${ruta}`);
  }
});

test('pagos: los de sus clientes o los pagados con uno de sus descuentos', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/payments/recent'), 200);
  assert.deepEqual(dondeDe('payment').OR, [{ user: { pais: 'EC' } }, { discountCode: { pais: 'EC' } }]);

  assert.equal(await pedir(DE_ECUADOR, 'GET', '/payments/manual/pending'), 200);
  assert.equal(dondeDe('payment').status, 'IN_REVIEW');
  assert.deepEqual(dondeDe('payment').OR, [{ user: { pais: 'EC' } }, { discountCode: { pais: 'EC' } }]);

  assert.equal(await pedir(DE_ECUADOR, 'GET', '/payments/manual/history'), 200);
  assert.deepEqual(dondeDe('payment').OR, [{ user: { pais: 'EC' } }, { discountCode: { pais: 'EC' } }]);

  await pedir(ADMIN, 'GET', '/payments/recent');
  assert.deepEqual(dondeDe('payment'), {});

  await pedir(ADMIN, 'GET', '/payments/recent?pais=ninguno');
  assert.deepEqual(dondeDe('payment').user, { pais: null });
});

test('el comprobante de un pago de otro país: no existe', async () => {
  filas = {};
  assert.equal(await pedir(DE_ECUADOR, 'GET', `/payments/manual/${ID}/proof`), 404);
  assert.deepEqual(dondeDe('payment', 'findFirst').OR, [
    { user: { pais: 'EC' } },
    { discountCode: { pais: 'EC' } },
  ]);
});

test('descuentos: solo los suyos, y no toca los de otro', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/billing/discounts'), 200);
  assert.deepEqual(dondeDe('discountCode'), { pais: 'EC' });

  await pedir(ADMIN, 'GET', '/billing/discounts');
  assert.deepEqual(dondeDe('discountCode'), {});

  filas = { discountCode: { pais: null } };
  assert.equal(await pedir(DE_ECUADOR, 'PATCH', `/billing/discounts/${ID}`, { active: false }), 404);
  assert.equal(await pedir(DE_ECUADOR, 'DELETE', `/billing/discounts/${ID}`), 404);
  filas = {};
});

test('un descuento suyo no se publica en la página de precios aunque lo pida', async () => {
  filas = { discountCode: { id: ID, pais: 'EC' } };
  assert.equal(await pedir(DE_ECUADOR, 'PATCH', `/billing/discounts/${ID}`, { publico: true }), 200);
  const cambio = consultas.find((c) => c.tabla === 'discountCode' && c.metodo === 'update');
  assert.deepEqual(cambio.argumentos.data, {});
  filas = {};
});

test('enlaces de prueba: solo los suyos, y no toca los de otro', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/pruebas'), 200);
  assert.deepEqual(dondeDe('trialLink'), { pais: 'EC' });

  filas = { trialLink: { pais: 'CO' } };
  assert.equal(await pedir(DE_ECUADOR, 'GET', `/pruebas/${ID}/invitados`), 404);
  assert.equal(await pedir(DE_ECUADOR, 'DELETE', `/pruebas/${ID}`), 404);
  assert.equal(await pedir(DE_ECUADOR, 'PATCH', `/pruebas/${ID}`, { active: false }), 404);
  filas = {};
});

test('lo que crea nace con su etiqueta; lo del dueño, sin ella', async () => {
  const creado = () => consultas.find((c) => c.tabla === 'discountCode' && c.metodo === 'create');

  assert.equal(await pedir(DE_ECUADOR, 'POST', '/billing/discounts', { amountCents: 2000 }), 201);
  assert.equal(creado().argumentos.data.pais, 'EC');
  assert.equal(creado().argumentos.data.publico, false);

  assert.equal(await pedir(ADMIN, 'POST', '/billing/discounts?pais=EC', { amountCents: 2000 }), 201);
  assert.equal(creado().argumentos.data.pais, null);
});

test('el cliente se queda con el primer país que lo consigue', async () => {
  const { etiquetarCliente } = require('../src/shared/utils/paisDelCliente');
  consultas = [];

  await etiquetarCliente('u1', null);
  assert.equal(consultas.length, 0);

  await etiquetarCliente('u1', 'EC');
  assert.deepEqual(consultas[0].argumentos, {
    where: { id: 'u1', pais: null, role: 'USER' },
    data: { pais: 'EC' },
  });
});

test('reclamos: los de un país son los del correo de sus clientes', async () => {
  const reclamoService = require('../src/modules/reclamos/reclamo.service');
  const hoja = (numero, email) => ({
    numero,
    email,
    createdAt: new Date('2026-10-01T15:00:00Z'),
    fechaLimite: new Date('2026-10-22T15:00:00Z'),
    montoReclamado: null,
  });
  listas = {
    reclamo: [hoja(3, 'Ana@ec.com'), hoja(2, 'luis@pe.com'), hoja(1, 'sin-cuenta@pe.com')],
    user: [{ email: 'ana@ec.com', pais: 'EC' }],
  };

  const numeros = async (filtro) => (await reclamoService.listar(filtro)).map((r) => r.numero);
  assert.deepEqual(await numeros(), [3, 2, 1]);
  assert.deepEqual(await numeros({ pais: 'EC' }), [3]);
  assert.deepEqual(await numeros({ pais: 'CO' }), []);
  assert.deepEqual(await numeros({ pais: null }), [2, 1]);
  listas = {};
});

test('avance de clientes: solo cuenta a los de su país', async () => {
  listas = { user: [{ id: 'u-ec', pais: 'EC' }, { id: 'u-co', pais: 'CO' }] };
  const donde = (nombre, metodo) =>
    consultas.find((c) => c.tabla === nombre && c.metodo === metodo).argumentos.where;

  assert.equal(await pedir(DE_ECUADOR, 'GET', '/embudo?pais=CO'), 200);
  assert.equal(donde('user', 'count').pais, 'EC');
  assert.equal(donde('license', 'findMany').user.pais, 'EC');
  assert.equal(donde('payment', 'groupBy').user.pais, 'EC');
  assert.deepEqual(donde('visitaEmbudo', 'groupBy').userId, { in: ['u-ec'] });
  assert.deepEqual(donde('referido', 'groupBy').invitador, { pais: 'EC' });
  assert.deepEqual(donde('avisoAvance', 'groupBy').user, { pais: 'EC' });

  // El dueño, sin filtro: nada de país en ninguna consulta, como antes.
  assert.equal(await pedir(ADMIN, 'GET', '/embudo'), 200);
  assert.equal('pais' in donde('user', 'count'), false);
  assert.equal('pais' in donde('license', 'findMany').user, false);
  assert.equal('userId' in donde('visitaEmbudo', 'groupBy'), false);
  assert.equal('invitador' in donde('referido', 'groupBy'), false);

  // Y solo lo de la casa: las visitas sin sesión se quedan con ella.
  await pedir(ADMIN, 'GET', '/embudo?pais=ninguno');
  assert.equal(donde('user', 'count').pais, null);
  assert.deepEqual(donde('visitaEmbudo', 'groupBy').OR, [
    { userId: null },
    { userId: { notIn: ['u-ec', 'u-co'] } },
  ]);
  listas = {};
});

test('reseñas: las de sus clientes', async () => {
  assert.equal(await pedir(DE_ECUADOR, 'GET', '/resenas/panel'), 200);
  assert.deepEqual(dondeDe('resenaServicio').user, { pais: 'EC' });

  await pedir(ADMIN, 'GET', '/resenas/panel');
  assert.deepEqual(dondeDe('resenaServicio'), {});
});
