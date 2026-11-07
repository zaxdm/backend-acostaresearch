'use strict';

/**
 * AcostaIA con la licencia que el usuario ya compró (7-nov-2026).
 *
 * Lo que se prueba: que del enlace pegado se saca el token; que vincular emite
 * OTRA licencia del mismo comprador y producto, marcada con la comprada y sin
 * caducidad propia, sin tocar la comprada; que vincular otra vez corta la
 * anterior; que no se vincula una de AcostaIA, una de prueba ni una caducada;
 * que buscar por correo solo da las compras vigentes de esa cuenta; que el
 * correo se vuelve a comprobar al vincular; y que desvincular solo corta la de
 * AcostaIA. La base y el servicio de licencias se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashToken } = require('../src/shared/utils/tokens');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { usuarios: [], licencias: [], revocadas: [] };

function cumple(fila, where) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in v) return (fila[k] ?? null) !== v.not;
    return (fila[k] ?? null) === v;
  });
}

const conUsuario = (l) => (l ? { ...l, user: estado.usuarios.find((u) => u.id === l.userId) } : null);

sustituir('../src/lib/prisma', {
  user: {
    findUnique: async ({ where }) => estado.usuarios.find((u) => cumple(u, where)) ?? null,
  },
  license: {
    findUnique: async ({ where }) => conUsuario(estado.licencias.find((l) => cumple(l, where))),
    findMany: async ({ where }) =>
      estado.licencias
        .filter((l) => cumple(l, where))
        .map((l) => ({
          ...conUsuario(l),
          acostaiaDe: estado.licencias.find((m) => m.id === l.acostaiaDeId) ?? null,
        })),
    create: async ({ data }) => {
      const fila = { id: `l${estado.licencias.length + 1}`, status: 'ACTIVE', ...data };
      estado.licencias.push(fila);
      return { id: fila.id };
    },
  },
});

sustituir('../src/modules/licensing/license.service', {
  urlDelConector: (token) => `https://api.ejemplo/mcp/${token}`,
  contratoDelProducto: async () => ({ nombre: 'Método de Tesis' }),
});

sustituir('../src/modules/licensing/license.repository', {
  setStatus: async (id, datos) => {
    estado.revocadas.push({ id, ...datos });
    Object.assign(estado.licencias.find((l) => l.id === id), { status: datos.status });
  },
});

const vinculos = require('../src/modules/acostaia/acostaia.vinculos');

const TOKEN = 'TokenDeLaCompra_0123456789abcdef';
const ENLACE = `https://api.acostaresearch.com/mcp/${TOKEN}`;

function compra(extra = {}) {
  return {
    id: 'comprada',
    userId: 'u-comprador',
    productCode: 'METODO_TESIS',
    status: 'ACTIVE',
    tokenHash: hashToken(TOKEN),
    tokenHint: TOKEN.slice(0, 8),
    expiresAt: null,
    acostaiaDeId: null,
    acostaiaId: null,
    callsPerDay: 50,
    callsPerMonth: 0,
    costCentsPerMonth: 900,
    callsLimitTotal: 0,
    costCentsLimitTotal: 0,
    delivery: 'EXECUTED',
    variasTesis: false,
    ...extra,
  };
}

test.beforeEach(() => {
  estado.usuarios = [
    { id: 'u-comprador', email: 'ana@ejemplo.pe', status: 'ACTIVE', trialLinkId: null, acostaiaId: null },
  ];
  estado.licencias = [compra()];
  estado.revocadas = [];
});

test('del enlace pegado se saca el token; lo que no es un enlace, no', () => {
  assert.equal(vinculos.tokenDelEnlace(ENLACE), TOKEN);
  assert.equal(vinculos.tokenDelEnlace(`  ${ENLACE}/ `), TOKEN);
  assert.equal(vinculos.tokenDelEnlace(TOKEN), TOKEN);
  assert.equal(vinculos.tokenDelEnlace('https://acostaresearch.com/planes'), null);
  assert.equal(vinculos.tokenDelEnlace(''), null);
});

test('vincular por enlace emite otra licencia atada a la comprada, sin tocarla', async () => {
  const r = await vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: ENLACE });

  assert.equal(r.productCode, 'METODO_TESIS');
  assert.equal(r.nombre, 'Método de Tesis');
  assert.match(r.connectorUrl, /^https:\/\/api\.ejemplo\/mcp\//);
  assert.ok(!r.connectorUrl.endsWith(TOKEN), 'no se reutiliza el enlace comprado');

  const nueva = estado.licencias.find((l) => l.id === r.licenseId);
  assert.equal(nueva.userId, 'u-comprador', 'misma cuenta: ve su misma tesis');
  assert.equal(nueva.acostaiaDeId, 'comprada');
  assert.equal(nueva.acostaiaId, 'usr_aia0001');
  assert.equal(nueva.expiresAt, null);
  assert.equal(nueva.callsPerDay, 50);
  assert.equal(estado.licencias[0].status, 'ACTIVE', 'la comprada sigue igual');
  assert.equal(estado.revocadas.length, 0);
});

test('vincular otra vez corta el conector de AcostaIA anterior, no la compra', async () => {
  const primera = await vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: ENLACE });
  await vinculos.porEnlace({ acostaiaId: 'usr_aia0002', enlace: ENLACE });

  assert.deepEqual(
    estado.revocadas.map((r) => r.id),
    [primera.licenseId],
  );
  assert.equal(estado.licencias[0].status, 'ACTIVE');
});

test('no se vincula un conector de AcostaIA, uno de prueba ni uno caducado', async () => {
  estado.licencias = [compra({ acostaiaDeId: 'otra' })];
  await assert.rejects(vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: ENLACE }), /ya es de AcostaIA/);

  estado.licencias = [compra({ expiresAt: new Date(Date.now() - 1000) })];
  await assert.rejects(vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: ENLACE }), /caducó/);

  estado.licencias = [compra()];
  estado.usuarios[0].trialLinkId = 'enlace-de-prueba';
  await assert.rejects(vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: ENLACE }), /caducó/);

  await assert.rejects(
    vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: `https://api.acostaresearch.com/mcp/${'x'.repeat(30)}` }),
    /No encontramos ese conector/,
  );
  assert.equal(estado.licencias.length, 1, 'no se creó nada');
});

test('buscar por correo da solo sus compras vigentes', async () => {
  estado.licencias.push(compra({ id: 'revocada', status: 'REVOKED', tokenHash: 'h2' }));
  estado.licencias.push(compra({ id: 'de-aia', acostaiaDeId: 'comprada', tokenHash: 'h3' }));

  const r = await vinculos.buscar({ email: 'ANA@ejemplo.pe ' });
  assert.deepEqual(
    r.map((x) => x.licenseId),
    ['comprada'],
  );
  assert.equal(r[0].nombre, 'Método de Tesis');
  assert.deepEqual(await vinculos.buscar({ email: 'otro@ejemplo.pe' }), []);
});

test('vincular por correo vuelve a comprobar que la compra es de ese correo', async () => {
  await assert.rejects(
    vinculos.porCorreo({ acostaiaId: 'usr_aia0001', email: 'otro@ejemplo.pe', licenseId: 'comprada' }),
    /No encontramos esa licencia/,
  );
  const r = await vinculos.porCorreo({ acostaiaId: 'usr_aia0001', email: 'ana@ejemplo.pe', licenseId: 'comprada' });
  assert.equal(estado.licencias.find((l) => l.id === r.licenseId).acostaiaDeId, 'comprada');
});

test('desvincular corta solo la de AcostaIA, y vigentes sigue a la comprada', async () => {
  await vinculos.porEnlace({ acostaiaId: 'usr_aia0001', enlace: ENLACE });
  assert.deepEqual(await vinculos.vigentes('usr_aia0001'), [{ userId: 'u-comprador', productCode: 'METODO_TESIS' }]);

  estado.licencias[0].expiresAt = new Date(Date.now() - 1000);
  assert.deepEqual(await vinculos.vigentes('usr_aia0001'), [], 'si la comprada caduca, ya no cuenta');
  estado.licencias[0].expiresAt = null;

  const { revocadas } = await vinculos.quitar({ acostaiaId: 'usr_aia0001', productCode: 'METODO_TESIS' });
  assert.equal(revocadas, 1);
  assert.equal(estado.licencias[0].status, 'ACTIVE', 'la compra no se toca');
  assert.deepEqual(await vinculos.vigentes('usr_aia0001'), []);
});
