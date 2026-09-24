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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Los videos se escriben en disco de verdad, así que van a una carpeta de usar
// y tirar. Se pone ANTES de cargar nada: el entorno se lee al requerir.
const CARPETA = fs.mkdtempSync(path.join(os.tmpdir(), 'resenas-'));
process.env.RESENAS_DIR = CARPETA;

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
/**
 * El `where` de Prisma, lo justo que usa este módulo: campos sueltos, `OR` y
 * `NOT`. Sin esto, el filtro de «que tenga algo que enseñar» —texto o video—
 * no se podría probar aquí.
 */
function cumple(fila, where = {}) {
  return Object.entries(where).every(([campo, valor]) => {
    if (campo === 'OR') return valor.some((cond) => cumple(fila, cond));
    if (campo === 'NOT') return !cumple(fila, valor);
    if (valor && typeof valor === 'object' && 'gt' in valor) return fila[campo] > valor.gt;
    return fila[campo] === valor;
  });
}

function proyectar(fila, select) {
  if (!select) return { ...fila };
  const salida = {};
  for (const [campo, pedido] of Object.entries(select)) {
    if (!pedido) continue;
    if (pedido === true) {
      salida[campo] = fila[campo];
    } else {
      salida[campo] = fila[campo] ? proyectar(fila[campo], pedido.select) : null;
    }
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
  // La firma pública sale del correo de la cuenta, así que la reseña ya no se
  // guarda sin mirar quién la escribe.
  user: {
    findUnique: async ({ where, select }) => {
      // Por correo solo existen las cuentas de la casa: así se puede probar qué
      // pasa cuando el panel apunta un correo que no compró nunca.
      if (where.email) {
        if (!where.email.endsWith('@correo.test')) return null;
        return proyectar(usuario(where.email.split('@')[0]), select);
      }
      return proyectar(usuario(where.id), select);
    },
  },
  resenaServicio: {
    findUnique: async ({ where, select }) => {
      const fila = [...estado.filas.values()].find(
        (f) => (where.id && f.id === where.id) || (where.userId && f.userId === where.userId),
      );
      return fila ? proyectar(fila, select) : null;
    },
    findMany: async ({ where = {}, select, take }) => {
      const filas = [...estado.filas.values()]
        .filter((f) => cumple(f, where))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, take ?? 500);
      return filas.map((f) => proyectar(f, select));
    },
    count: async ({ where = {} }) => [...estado.filas.values()].filter((f) => cumple(f, where)).length,
    aggregate: async ({ where = {} }) => {
      const filas = [...estado.filas.values()].filter((f) => cumple(f, where));
      return {
        _count: { _all: filas.length },
        _sum: { estrellas: filas.reduce((suma, f) => suma + f.estrellas, 0) },
      };
    },
    create: async ({ data, select }) => {
      const fila = {
        id: `resena-${estado.filas.size + 1}`,
        destacada: false,
        delPanel: false,
        videoBytes: 0,
        videoTipo: '',
        motivo: '',
        oficio: '',
        correo: '',
        revisadaPorId: null,
        revisadaAt: null,
        createdAt: new Date(Date.now() + estado.filas.size),
        updatedAt: new Date(),
        ...data,
        // Nulo cuando la dio de alta el panel a nombre de alguien sin cuenta.
        user: data.userId ? usuario(data.userId) : null,
      };
      estado.filas.set(fila.id, fila);
      return proyectar(fila, select);
    },
    update: async ({ where, data, select }) => {
      const fila = estado.filas.get(where.id);
      Object.assign(fila, data, { updatedAt: new Date() });
      return proyectar(fila, select);
    },
    delete: async ({ where, select }) => {
      const fila = estado.filas.get(where.id);
      estado.filas.delete(where.id);
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
  oficio: 'Tesista de maestría',
};

function empezar() {
  estado.filas.clear();
  estado.avisos.length = 0;
}

// ── Lo que acepta el formulario ─────────────────────────────────────────────

test('una nota suelta sin texto ni video no es un testimonio', async () => {
  empezar();
  // El esquema ya la deja pasar —puede ser una reseña de solo video—, y es el
  // servicio el que la para cuando no hay ni lo uno ni lo otro.
  assert.equal(resenaBodySchema.safeParse({ ...RESENA, comentario: 'Muy bueno' }).success, true);

  await assert.rejects(
    () => resenaService.guardar('u1', { ...RESENA, comentario: 'Muy bueno' }),
    /al menos una frase|sube tu video/i,
  );
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

test('cambiar una la devuelve a pendiente y le quita lo que había ganado', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA', destacada: true }, 'admin1');

  const cambiada = await resenaService.guardar('u1', { ...RESENA, estrellas: 1 }, fila.id);

  assert.equal(cambiada.estado, 'PENDIENTE');
  assert.equal(cambiada.destacada, false);
  // Cambiar la suya no estrena fila: se cambia esa.
  assert.equal((await resenaService.listar('TODAS')).length, 1);
  assert.deepEqual((await resenaService.publicas()).resenas, []);
});

test('una misma cuenta puede dejar varias, y cada una va por su lado', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  await resenaService.guardar('u1', { ...RESENA, comentario: 'Volví seis meses después y terminé la discusión.' });

  const mias = await resenaService.mias('u1');
  assert.equal(mias.length, 2);
  // Las últimas primero, que es como se leen.
  assert.match(mias[0].comentario, /seis meses/);

  // Se aprueba una y la otra sigue esperando: son dos cosas distintas.
  await resenaService.revisar(mias[0].id, { estado: 'APROBADA' }, 'admin1');
  const despues = await resenaService.mias('u1');
  assert.equal(despues[0].estado, 'APROBADA');
  assert.equal(despues[1].estado, 'PENDIENTE');
});

test('pero no las que quiera: hay un tope por cuenta', async () => {
  empezar();
  for (let n = 0; n < 10; n += 1) await resenaService.guardar('u1', RESENA);

  await assert.rejects(() => resenaService.guardar('u1', RESENA), /Ya has dejado 10/);
  assert.equal((await resenaService.mias('u1')).length, 10);
});

test('nadie toca la reseña de otro, ni la suya si la publicamos nosotros', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [suya] = await resenaService.listar('TODAS');

  // De otro: ni existe, para quien pregunta.
  await assert.rejects(() => resenaService.suya(suya.id, 'u2'), /no existe/);

  // La que dio de alta el panel a su nombre: la ve, pero no la toca.
  const delPanel = await resenaService.crearDesdeElPanel(
    { email: 'u1@correo.test', estrellas: 5, comentario: RESENA.comentario, oficio: '' },
    'admin1',
  );
  await assert.rejects(() => resenaService.suya(delPanel.id, 'u1'), /Escríbenos/);
  await assert.rejects(
    () => resenaService.guardar('u1', { ...RESENA, estrellas: 1 }, delPanel.id),
    /Escríbenos/,
  );
  // Y sigue saliendo entre las suyas: verla sí puede.
  assert.equal((await resenaService.mias('u1')).length, 2);
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

// ── Lo público lleva el correo tapado, nunca entero ─────────────────────────

test('la lista pública no reparte el correo de los clientes', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA' }, 'admin1');

  const { resenas } = await resenaService.publicas();

  assert.equal(resenas.length, 1);
  assert.deepEqual(Object.keys(resenas[0]).sort(), [
    'autor',
    'comentario',
    // Que detrás de la firma hay una cuenta. El identificador de esa cuenta no:
    // entra al cálculo y se queda dentro.
    'conCuenta',
    'createdAt',
    // La marca de la portada, que /resenas enseña. De la moderación no sale
    // nada más: ni el estado, ni el motivo de un rechazo, ni quién la revisó.
    'destacada',
    'estrellas',
    'id',
    'oficio',
    // Si tiene video o no. Ni el peso ni la ruta: eso es de quien lo sirve.
    'video',
  ]);
  // Ni el correo entero ni el campo del que sale.
  assert.doesNotMatch(JSON.stringify(resenas[0]), /u1@correo\.test/);
});

test('la firma dice si detrás hay una cuenta, y no reparte el identificador', async () => {
  empezar();
  // Una escrita por un cliente con su cuenta…
  await resenaService.guardar('u1', RESENA);
  // …y otra apuntada a mano desde el panel, de quien compró por otra vía.
  await resenaService.crearDesdeElPanel(
    { email: 'nadie@gmail.com', estrellas: 5, comentario: RESENA.comentario, oficio: '' },
    'admin1',
  );
  const [, suya] = await resenaService.listar('TODAS');
  await resenaService.revisar(suya.id, { estado: 'APROBADA' }, 'admin1');

  const { resenas } = await resenaService.publicas();

  assert.equal(resenas.length, 2);
  // La del cliente va respaldada; la del panel sin cuenta, no, y la web lo dice
  // en vez de enseñarlas iguales.
  assert.equal(resenas.find((r) => r.autor.startsWith('u1')).conCuenta, true);
  assert.equal(resenas.find((r) => r.autor.startsWith('nadi')).conCuenta, false);
  // Y el identificador de la cuenta no viaja con la reseña.
  assert.equal('userId' in resenas[0], false);
});

test('la firma es el correo tapado: cuatro letras y el dominio', async () => {
  empezar();
  await resenaService.guardar('steban', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA' }, 'admin1');

  const { resenas } = await resenaService.publicas();

  assert.equal(resenas[0].autor, 'steb***@correo.test');
  // El panel la ve igual que la web, y además con el correo entero al lado.
  assert.equal(fila.autor, 'steb***@correo.test');
  assert.equal(fila.user.email, 'steban@correo.test');
});

test('quien la escribe ve con qué firma va a salir antes de enviarla', async () => {
  empezar();
  const suya = await resenaService.guardar('ordonez', RESENA);

  assert.equal(suya.autor, 'ordo***@correo.test');
  assert.equal(suya.estado, 'PENDIENTE');
  assert.equal((await resenaService.mias('ordonez'))[0].autor, 'ordo***@correo.test');
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

// ── El video del testimonio ─────────────────────────────────────────────────

/** Un MP4 de mentira: lo que se mira son los bytes 4 a 8. */
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(64)]);

test('lo que no es un video no se guarda como si lo fuera', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');

  await assert.rejects(
    () => resenaService.guardarVideo(fila.id, Buffer.from('esto es un .exe con otro nombre')),
    /MP4, MOV o WebM/,
  );
});

test('subir el video la devuelve a revisión y la baja de la portada', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.revisar(fila.id, { estado: 'APROBADA', destacada: true }, 'admin1');

  const conVideo = await resenaService.guardarVideo(fila.id, MP4);

  assert.equal(conVideo.video, true);
  assert.equal(conVideo.estado, 'PENDIENTE');
  assert.equal(conVideo.destacada, false);
  // Y el archivo está donde se va a buscar para servirlo.
  const { ruta, tipo } = await resenaService.paraVer(fila.id, { soloAprobadas: false });
  assert.equal(tipo, 'video/mp4');
  assert.equal(fs.readFileSync(ruta).length, MP4.length);
});

test('el video de una reseña sin aprobar no se sirve a cualquiera', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.guardarVideo(fila.id, MP4);

  await assert.rejects(() => resenaService.paraVer(fila.id), /no tiene video/);
});

test('con video, la reseña puede quedarse sin una sola palabra', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.guardarVideo(fila.id, MP4);

  // El testimonio es la grabación: el texto ya no hace falta.
  const soloVideo = await resenaService.guardar('u1', { ...RESENA, comentario: '' }, fila.id);
  assert.equal(soloVideo.comentario, '');
  assert.equal(soloVideo.video, true);

  // Y quitarle el video la dejaría sin nada que enseñar, así que no se quita.
  await assert.rejects(() => resenaService.quitarVideo(fila.id), /sin nada que enseñar/);
});

test('la que trae el video detrás puede nacer sin texto', async () => {
  empezar();
  // El formulario deja elegir el video antes de enviar: primero se crea la
  // reseña y después se sube la grabación, así que al crearla aún no la tiene.
  const nueva = await resenaService.guardar('u1', { ...RESENA, comentario: '', conVideo: true });
  assert.equal(nueva.comentario, '');
  assert.equal(nueva.estado, 'PENDIENTE');

  const conGrabacion = await resenaService.guardarVideo(nueva.id, MP4);
  assert.equal(conGrabacion.video, true);
});

test('una reseña sin texto y sin video no sale en la web ni cuenta para la media', async () => {
  empezar();
  for (const userId of ['u1', 'u2']) await resenaService.guardar(userId, RESENA);
  const filas = await resenaService.listar('TODAS');
  for (const fila of filas) await resenaService.revisar(fila.id, { estado: 'APROBADA' }, 'admin1');
  // Se le vacía el texto a una por detrás, como quedaría un alta del panel a la
  // espera de su video.
  estado.filas.get(filas[0].id).comentario = '';

  const { resenas, total } = await resenaService.publicas();

  assert.equal(resenas.length, 1);
  // Y el «sobre N reseñas» cuenta una, no dos: la vacía no se enseña en ningún
  // sitio, así que tampoco puede sostener una media.
  assert.equal(total, 1);
});

// ── El panel también da de alta ─────────────────────────────────────────────

test('sin cuenta detrás se guarda igual, pero el panel lo dice', async () => {
  empezar();
  const resena = await resenaService.crearDesdeElPanel(
    { email: 'nadie@gmail.com', estrellas: 5, comentario: RESENA.comentario, oficio: '' },
    'admin1',
  );

  // Se guarda —hay quien compró por otra vía— y se firma con ese correo…
  assert.equal(resena.autor, 'nadi***@gmail.com');
  assert.equal(resena.estado, 'APROBADA');
  // …pero queda marcada, porque una firma sin cuenta no se puede comprobar.
  assert.equal(resena.sinCuenta, true);
  assert.equal(resena.user, null);

  // Con cuenta, lo contrario.
  const conCuenta = await resenaService.crearDesdeElPanel(
    { email: 'aldair@correo.test', estrellas: 5, comentario: RESENA.comentario, oficio: '' },
    'admin1',
  );
  assert.equal(conCuenta.sinCuenta, false);
});

test('la que da de alta el panel nace publicada y firmada con el correo del cliente', async () => {
  empezar();
  const resena = await resenaService.crearDesdeElPanel(
    { email: 'aldair@correo.test', estrellas: 5, comentario: RESENA.comentario, oficio: 'Ing. Civil' },
    'admin1',
  );

  assert.equal(resena.estado, 'APROBADA');
  assert.equal(resena.autor, 'alda***@correo.test');
  // Y marcada como del panel: su titular no la escribió, así que no la toca.
  assert.equal(resena.delPanel, true);
  assert.equal((await resenaService.publicas()).resenas.length, 1);
});

test('el video que sube el panel no devuelve la reseña a pendiente', async () => {
  empezar();
  const resena = await resenaService.crearDesdeElPanel(
    { email: 'aldair@correo.test', estrellas: 5, comentario: RESENA.comentario, oficio: '' },
    'admin1',
  );

  const conVideo = await resenaService.guardarVideo(resena.id, MP4, { aRevisar: false });

  assert.equal(conVideo.estado, 'APROBADA');
  assert.equal(conVideo.video, true);
});

test('revisar una reseña que no existe no revisa nada', async () => {
  empezar();
  await assert.rejects(
    () => resenaService.revisar('no-existe', { estado: 'APROBADA' }, 'admin1'),
    /no existe/,
  );
});

// ── Borrarla del todo ───────────────────────────────────────────────────────

test('borrarla se lleva la fila, su video y lo que contaba para la media', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);
  const [fila] = await resenaService.listar('TODAS');
  await resenaService.guardarVideo(fila.id, MP4);
  await resenaService.revisar(fila.id, { estado: 'APROBADA' }, 'admin1');
  const { ruta } = await resenaService.paraVer(fila.id);

  await resenaService.borrar(fila.id, 'admin1');

  // Ni en el panel, ni en la web, ni en la media: rechazarla la escondía, esto
  // la quita.
  assert.equal((await resenaService.listar('TODAS')).length, 0);
  const { resenas, total, nota } = await resenaService.publicas();
  assert.equal(resenas.length, 0);
  assert.equal(total, 0);
  assert.equal(nota, null);
  // Y el video no se queda ocupando disco a nombre de nadie.
  assert.equal(fs.existsSync(ruta), false);
});

test('borrar una reseña que no existe no borra nada', async () => {
  empezar();
  await resenaService.guardar('u1', RESENA);

  await assert.rejects(() => resenaService.borrar('no-existe', 'admin1'), /no existe/);

  assert.equal((await resenaService.listar('TODAS')).length, 1);
});
