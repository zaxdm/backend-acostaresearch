'use strict';

/**
 * Los enlaces cortos, `/s/<código>`.
 *
 * Existen porque el asistente no copia un JWT de 400 caracteres: lo reescribe y
 * se equivoca en uno. Ver `EnlaceCorto` en el esquema para la prueba.
 *
 * Lo que no puede torcerse:
 *
 *   · el código se guarda con la MISMA caducidad que el token que lleva dentro
 *     —un código vivo que lleve a un token muerto le diría «llegó incompleto» a
 *     quien solo llegó tarde—;
 *   · «venció» y «llegó incompleto» siguen siendo dos cosas distintas;
 *   · si la base falla, se devuelve el enlace largo en vez de ninguno;
 *   · el alfabeto no tiene caracteres que se confundan al leerlos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const filas = new Map();
let fallarAlCrear = 0;

sustituir('../src/lib/prisma', {
  enlaceCorto: {
    create: async ({ data }) => {
      if (fallarAlCrear > 0) {
        fallarAlCrear -= 1;
        const error = new Error('Unique constraint');
        error.code = 'P2002';
        throw error;
      }
      if (filas.has(data.codigo)) {
        const error = new Error('Unique constraint');
        error.code = 'P2002';
        throw error;
      }
      filas.set(data.codigo, { ...data });
      return data;
    },
    findUnique: async ({ where }) => filas.get(where.codigo) ?? null,
    deleteMany: async ({ where }) => {
      let count = 0;
      for (const [codigo, fila] of filas) {
        if (fila.expiresAt < where.expiresAt.lt) {
          filas.delete(codigo);
          count += 1;
        }
      }
      return { count };
    },
  },
});

const enlaceCorto = require('../src/modules/enlaces/enlaceCorto.service');

const DESTINO = 'https://acostaresearch.com/subir-material/eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJ4In0.abc-_123';

test('el enlace corto es corto de verdad y lleva al largo', async () => {
  filas.clear();
  const url = await enlaceCorto.acortar({ destino: DESTINO, minutos: 30, base: 'https://api.acostaresearch.com' });

  assert.match(url, /^https:\/\/api\.acostaresearch\.com\/s\/[A-Z2-9]{8}$/);
  // El punto de todo esto: cabe de sobra donde no cabían 400 caracteres.
  assert.ok(url.length < 45, `demasiado largo: ${url.length}`);

  const codigo = url.split('/').pop();
  assert.equal((await enlaceCorto.resolver(codigo)).destino, DESTINO);
});

test('el código vence a la vez que el token que lleva dentro', async () => {
  filas.clear();
  const antes = Date.now();
  const url = await enlaceCorto.acortar({ destino: DESTINO, minutos: 30, base: 'https://x.y' });
  const fila = filas.get(url.split('/').pop());

  const duracion = fila.expiresAt.getTime() - antes;
  assert.ok(duracion >= 29 * 60 * 1000 && duracion <= 31 * 60 * 1000, `duró ${duracion} ms`);
});

test('pasada la hora dice que venció; uno inventado, que llegó incompleto', async () => {
  filas.clear();
  filas.set('VENCIDO1', { codigo: 'VENCIDO1', destino: DESTINO, expiresAt: new Date(Date.now() - 1000) });

  assert.deepEqual(await enlaceCorto.resolver('VENCIDO1'), { motivo: 'vencido' });
  assert.deepEqual(await enlaceCorto.resolver('NOEXISTE'), { motivo: 'desconocido' });
  // Sin código tampoco se rompe.
  assert.deepEqual(await enlaceCorto.resolver(undefined), { motivo: 'desconocido' });
});

test('si el código chocara, se reintenta en vez de fallar', async () => {
  filas.clear();
  fallarAlCrear = 3;
  const url = await enlaceCorto.acortar({ destino: DESTINO, minutos: 30, base: 'https://x.y' });
  assert.match(url, /\/s\/[A-Z2-9]{8}$/);
  assert.equal(fallarAlCrear, 0, 'se agotaron los tres choques preparados');
});

test('si no hay manera de acortar, se devuelve el enlace largo y no nada', async () => {
  filas.clear();
  fallarAlCrear = 99;
  const url = await enlaceCorto.acortar({ destino: DESTINO, minutos: 30, base: 'https://x.y' });
  assert.equal(url, DESTINO, 'una dirección fea es mejor que ninguna');
  fallarAlCrear = 0;
});

test('el alfabeto no tiene caracteres que se confundan al leerlos', () => {
  for (const confuso of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!enlaceCorto.ALFABETO.includes(confuso), `${confuso} se confunde con otro`);
  }
  assert.equal(enlaceCorto.LARGO, 8);
});

test('la limpieza se lleva lo que caducó hace más de un día, y nada más', async () => {
  filas.clear();
  const dia = 24 * 60 * 60 * 1000;
  filas.set('VIEJO111', { codigo: 'VIEJO111', destino: DESTINO, expiresAt: new Date(Date.now() - 2 * dia) });
  filas.set('RECIEN11', { codigo: 'RECIEN11', destino: DESTINO, expiresAt: new Date(Date.now() - 1000) });
  filas.set('VIVO1111', { codigo: 'VIVO1111', destino: DESTINO, expiresAt: new Date(Date.now() + dia) });

  assert.equal(await enlaceCorto.limpiar(), 1);
  assert.ok(!filas.has('VIEJO111'));
  // El de hace un rato se queda: es el que permite decir «venció» y no «incompleto».
  assert.ok(filas.has('RECIEN11'));
  assert.ok(filas.has('VIVO1111'));
});
