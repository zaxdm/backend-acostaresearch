'use strict';

/**
 * Las reseñas del servicio.
 *
 * Lo que se prueba: que ninguna nazca publicada, que reescribir la suya la
 * devuelva a pendiente y le quite lo que había ganado, que lo público no lleve
 * el correo de nadie, que la media se cuente sobre todas las aprobadas y no
 * sobre las cuatro elegidas para la portada, y que no se pueda destacar lo que
 * no está aprobado. La base y los avisos se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { filas: new Map(), avisos: [] };

/**
 * Aplica el `select` de Prisma, que es justo lo que hay que respetar aquí: la
 * prueba de que lo público no lleva correo no vale nada si el doble devuelve la
 * fila entera pase lo que pase.
 */
function proyectar(fila, select) {
  if (!select) return { ...fila };
  const salida = {};
  for (const [campo, pedido] of Object.entries(select)) {
    if (!pedido) continue;
    salida[campo] = pedido === true ? fila[campo] : proyectar(fila[campo] ?? {}, pedido.select);
  }
  return salida;
}

const usuario = (id) => ({
  id,
  email: `${id}@correo.test`,
  firstName: 'Ana',
  lastName: 'Quispe',
});

sustituir('../src/lib/prisma', {
  resenaServicio: {
    findUnique: async ({ where, select }) => {
      const fila = [...estado.filas.values()].find(
        (f) => (where.id && f.id === where.id) || (where.userId && f.userId === where.userId),
      );
      return fila ? proyectar(fila, select) : null;
    },
    findMany: async ({ where = {}, select, take }) => {
      const filas = [...estado.filas.values()]
        .filter((f) => Object.entries(where).every(([campo, valor]) => f[campo] === valor))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, take ?? 500);
      return filas.map((f) => proyectar(f, select));
    },
    count: async ({ where = {} }) =>
      [...estado.filas.values()].filter((f) =>
        Object.entries(where).every(([campo, valor]) => f[campo] === valor),
      ).length,
    aggregate: async ({ where = {} }) => {
      const filas = [...estado.filas.values()].filter((f) =>
        Object.entries(where).every(([campo, valor]) => f[campo] === valor),
      );
      return {
        _count: { _all: filas.length },
        _sum: { estrellas: filas.reduce((suma, f) => suma + f.estrellas, 0) },
      };
    },
    upsert: async ({ where, create, update, select }) => {
      const existente = [...estado.filas.values()].find((f) => f.userId === where.userId);
      if (existente) {
        Object.assign(existente, update, { updatedAt: new Date() });
        return proyectar(existente, select);
      }
      const fila = {
        id: `resena-${estado.filas.size + 1}`,
        destacada: false,
        motivo: '',
        oficio: '',
        revisadaPorId: null,
        revisadaAt: null,
        createdAt: new Date(Date.now() + estado.filas.size),
        updatedAt: new Date(),
        ...create,
        user: usuario(create.userId),
      };
      estado.filas.set(fila.id, fila);
      return proyectar(fila, select);
    },
    update: async ({ where, data, select }) => {
      const fila = estado.filas.get(where.id);
      Object.assign(fila, data, { updatedAt: new Date() });
      return proyectar(fila, select);
    },
  },
});
sustituir('../src/lib/notify', { avisarAlAdmin: (aviso) => estado.avisos.push(aviso) });

const { resenaBodySchema, revisionSchema } = require('../src/modules/resenas/resena.schema');
const resenaService = require('../src/modules/resenas/resena.service');

const RESENA = {
  estrellas: 5,
  comentario: 'Terminé el capítulo IV en una semana y el Word salió en la norma de mi universidad.',
  nombre: 'Ana Q.',
  oficio: 'Tesista de maestría',
};

function empezar() {
  estado.filas.clear();
  estado.avisos.length = 0;
}

// ── Lo que acepta el formulario ─────────────────────────────────────────────

test('una nota suelta sin texto no es un testimonio', () => {
  const corto = resenaBodySchema.safeParse({ ...RESENA, comentario: 'Muy bueno' });
  assert.equal(corto.success, false);
  assert.match(corto.error.issues[0].message, /al menos una frase/);
});

test('las estrellas van de una a cinco', () => {
  for (const estrellas of [0, 6, -1]) {
    assert.equal(resenaBodySchema.safeParse({ ...RESENA, estrellas }).success, false);
  }
  assert.equal(resenaBodySchema.safeParse({ ...RESENA, estrellas: 3 }).success, true);
});

test('el oficio se puede dejar en blanco', () => {
  const sinOficio = resenaBodySchema.safeParse({ ...RESENA, oficio: undefined });
  assert.equal(sinOficio.success, true);
  assert.equal(sinOficio.data.oficio, '');
});

test('una revisión vacía no es una revisión', () => {
  assert.equal(revisionSchema.safeParse({}).success, false);
  assert.equal(revisionSchema.safeParse({ estado: 'APROBADA' }).success, true);
});

// ── Ninguna se publica sola ─────────────────────────────────────────────────

test('nace pendiente y avisa al administrador', async () => {
  empezar();

  const resena = await resenaService.guardar('u1', RESENA);

  assert.equal(resena.estado, 'PENDIENTE');
  assert.equal(resena.destacada, false);
  assert.equal(estado.avisos.length, 1);
  // El aviso va por un tópico que no es privado: ni el texto ni el nombre.
  assert.doesNotMatch(JSON.stringify(estado.avisos[0]), /Ana/);
});

test('no se ve en la web hasta que se aprueba', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);

  const antes = await resenaService.publicas();
  assert.deepEqual(antes.resenas, []);
  assert.equal(antes.total, 0);
  assert.equal(antes.nota, null);

  const [pendiente] = await resenaService.listar('PENDIENTE');
  await resenaService.revisar(pendiente.id, { estado: 'APROBADA' }, 'admin1');

  const despues = await resenaService.publicas();
  assert.equal(despues.resenas.length, 1);
  assert.equal(despues.nota, 5);
});

test('reescribirla la devuelve a pendiente y le quita lo que había ganado', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA', destacada: true }, 'admin1');

  const cambiada = await resenaService.guardar('u1', { ...RESENA, estrellas: 1 });

  assert.equal(cambiada.estado, 'PENDIENTE');
  assert.equal(cambiada.destacada, false);
  // Y sigue siendo UNA: reescribir no estrena fila.
  assert.equal((await resenaService.listar('TODAS')).length, 1);
  assert.deepEqual((await resenaService.publicas()).resenas, []);
});

test('rechazarla guarda el motivo, y volver a escribirla lo borra', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');

  const rechazada = await resenaService.revisar(
    fila.id,
    { estado: 'RECHAZADA', motivo: 'Cuenta algo de tu experiencia, no solo que te gustó.' },
    'admin1',
  );
  assert.equal(rechazada.estado, 'RECHAZADA');
  assert.match(rechazada.motivo, /experiencia/);

  const otra = await resenaService.guardar('u1', RESENA);
  assert.equal(otra.motivo, '');
});

// ── Lo público no lleva correo ──────────────────────────────────────────────

test('la lista pública no reparte el correo de los clientes', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA' }, 'admin1');

  const { resenas } = await resenaService.publicas();

  assert.equal(resenas.length, 1);
  assert.deepEqual(Object.keys(resenas[0]).sort(), [
    'comentario',
    'createdAt',
    'estrellas',
    'id',
    'nombre',
    'oficio',
  ]);
});

// ── La media dice la verdad ─────────────────────────────────────────────────

test('la media se cuenta sobre todas las aprobadas, no sobre las destacadas', async () => {
  empezar();
  // Tres aprobadas: 5, 5 y 2. Solo las dos de cinco se destacan.
  for (const [userId, estrellas] of [
    ['u1', 5],
    ['u2', 5],
    ['u3', 2],
  ]) {
    await resenaService.guardar(userId, { ...RESENA, estrellas });
  }
  for (const fila of await resenaService.listar('TODAS')) {
    await resenaService.revisar(
      fila.id,
      { estado: 'APROBADA', destacada: fila.estrellas === 5 },
      'admin1',
    );
  }

  const portada = await resenaService.publicas({ soloDestacadas: true });

  // Enseña las dos elegidas…
  assert.equal(portada.resenas.length, 2);
  // …pero la media y el total son los de verdad: (5+5+2)/3 = 4.
  assert.equal(portada.total, 3);
  assert.equal(portada.nota, 4);
});

test('sin ninguna destacada, la portada recibe las últimas aprobadas', async () => {
  empezar();
  for (const userId of ['u1', 'u2']) await resenaService.guardar(userId, RESENA);
  // Se aprueban las dos y no se destaca ninguna, que es lo que pasa siempre
  // que nadie se acuerda de ese interruptor.
  for (const fila of await resenaService.listar('TODAS')) {
    await resenaService.revisar(fila.id, { estado: 'APROBADA' }, 'admin1');
  }

  const portada = await resenaService.publicas({ soloDestacadas: true });

  assert.equal(portada.resenas.length, 2);
  assert.equal(portada.total, 2);
});

test('con alguna destacada, el respaldo no se mete y manda lo elegido', async () => {
  empezar();
  for (const userId of ['u1', 'u2']) await resenaService.guardar(userId, RESENA);
  const filas = await resenaService.listar('TODAS');
  await resenaService.revisar(filas[0].id, { estado: 'APROBADA', destacada: true }, 'admin1');
  await resenaService.revisar(filas[1].id, { estado: 'APROBADA' }, 'admin1');

  const portada = await resenaService.publicas({ soloDestacadas: true });

  assert.equal(portada.resenas.length, 1);
  assert.equal(portada.resenas[0].id, filas[0].id);
});

// ── Destacar es un permiso aparte ───────────────────────────────────────────

test('no se destaca lo que no está aprobado', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');

  const soloDestacar = await resenaService.revisar(fila.id, { destacada: true }, 'admin1');
  assert.equal(soloDestacar.destacada, false);

  // En la misma llamada sí: aprobar y destacar a la vez es lo normal.
  const ambas = await resenaService.revisar(
    fila.id,
    { estado: 'APROBADA', destacada: true },
    'admin1',
  );
  assert.equal(ambas.destacada, true);
});

test('retirarla de la web la baja también de la portada', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA', destacada: true }, 'admin1');

  const retirada = await resenaService.revisar(fila.id, { estado: 'PENDIENTE' }, 'admin1');

  assert.equal(retirada.destacada, false);
  assert.deepEqual((await resenaService.publicas({ soloDestacadas: true })).resenas, []);
});

test('revisar una reseña que no existe no revisa nada', async () => {
  empezar();
  await assert.rejects(
    () => resenaService.revisar('no-existe', { estado: 'APROBADA' }, 'admin1'),
    /no existe/,
  );
});
