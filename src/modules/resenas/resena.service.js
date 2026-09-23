'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { avisarAlAdmin } = require('../../lib/notify');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');

/**
 * Las reseñas del servicio.
 *
 * NINGUNA SE PUBLICA SOLA
 * -----------------------
 * Nace PENDIENTE y solo la mueve un administrador desde el panel. Lo que sale
 * en la portada con la marca encima lo firma la casa, no quien lo escribió.
 *
 * UNA POR CUENTA
 * --------------
 * Quien ya opinó y vuelve no estrena una fila: reescribe la suya, con `upsert`.
 * Y al reescribirla vuelve a PENDIENTE, porque si no bastaría con dejar una
 * reseña educada, esperar a que se apruebe y luego editarla.
 *
 * LO PÚBLICO LLEVA EL CORREO A MEDIAS, Y NUNCA ENTERO
 * ---------------------------------------------------
 * Una reseña no se firma con un nombre escrito a mano: se firma con el correo
 * de la cuenta tapado —`steb***@gmail.com`—, que es lo que la vuelve creíble.
 * Un nombre lo escribe cualquiera; un correo tapado enseña que detrás hay una
 * cuenta de verdad sin repartir la dirección de nadie.
 *
 * El correo entero NO SALE NUNCA de aquí por la puerta pública. Se selecciona
 * para taparlo y se tapa en un solo sitio, `firma()`, antes de devolver la
 * fila. Ninguna respuesta de fuera lleva el campo `user`: lo quita el mismo
 * paso que calcula la firma, para que no dependa de acordarse.
 */

/**
 * Lo que se lee de una reseña para enseñarla fuera.
 *
 * El correo entra aquí para taparse, no para salir: lo que se devuelve es lo
 * que deja `comoSeVe()`. `nombre` ya no está —dejó de ser público— y sigue en
 * la tabla porque es de quién es la reseña, que es lo que el panel necesita.
 */
const CAMPOS_PUBLICOS = {
  id: true,
  estrellas: true,
  comentario: true,
  oficio: true,
  createdAt: true,
  videoBytes: true,
  videoTipo: true,
  user: { select: { email: true } },
};

/** Lo que ve su autor: lo suyo, más en qué punto está. */
const CAMPOS_PROPIOS = {
  ...CAMPOS_PUBLICOS,
  estado: true,
  motivo: true,
  destacada: true,
  updatedAt: true,
};

/** Lo que ve el panel. Añade de quién es, que es lo que allí hace falta. */
const CAMPOS_PANEL = {
  ...CAMPOS_PROPIOS,
  nombre: true,
  revisadaAt: true,
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
};

/**
 * La firma pública: «steb***@gmail.com».
 *
 * Cuatro letras y el dominio. Con menos no se reconoce quién es ni el propio
 * autor —y el autor tiene que reconocerse, que es lo que le da confianza para
 * dejarla—; con más se adivina la dirección entera de un cliente en una página
 * que lee cualquiera.
 *
 * Un correo raro o ausente no revienta la página: firma como cliente y ya.
 */
function firma(email) {
  const [local = '', dominio = ''] = String(email ?? '').split('@');
  if (!local || !dominio) return 'cliente***';
  return `${local.slice(0, 4)}***@${dominio}`;
}

/**
 * Como se ve fuera: con la firma calculada y SIN el correo entero.
 *
 * Del video solo sale si lo hay. El peso y el tipo son cosa de quien lo sirve,
 * y la web únicamente necesita saber si tiene que pintar el reproductor.
 */
function comoSeVe({ user, videoBytes, videoTipo, ...resto }) {
  return { ...resto, autor: firma(user?.email), video: videoBytes > 0 };
}

/** Como la ve el panel: lo mismo, pero conservando de quién es. */
function comoLaVeElPanel(fila) {
  return { ...comoSeVe(fila), user: fila.user };
}

/** La media, redondeada a un decimal. Null sin ninguna: no hay media de nada. */
function media(suma, cuantas) {
  return cuantas === 0 ? null : Math.round((suma / cuantas) * 10) / 10;
}

// ── El video del testimonio ─────────────────────────────────────────────────
// En disco y no en la base: un minuto de móvil son decenas de megas. El nombre
// del archivo es el identificador de la reseña, así que lo que subió nadie
// decide dónde se escribe.

const rutaDelVideo = (id) => path.join(env.resenasDir, `${id}.video`);

/**
 * Que lo subido sea un video de verdad, mirando sus primeros bytes.
 *
 * No basta con creerse la extensión ni el tipo que declare el navegador: los
 * dos los escribe quien sube. MP4, MOV y WebM cubren lo que graba un móvil y
 * lo que exporta cualquier editor.
 */
function tipoDelVideo(archivo) {
  if (!Buffer.isBuffer(archivo) || archivo.length === 0) {
    throw new ValidationError('Falta el video.');
  }
  if (archivo.length > env.RESENA_VIDEO_MAX_BYTES) {
    const tope = Math.round(env.RESENA_VIDEO_MAX_BYTES / (1024 * 1024));
    throw new ValidationError(`El video pesa demasiado. El tope son ${tope} MB.`);
  }

  if (archivo.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (archivo.subarray(4, 8).toString('latin1') === 'ftyp') {
    // El de los iPhone sin convertir. Se sirve con su tipo y no disfrazado de
    // MP4: si el navegador de quien mira no lo reproduce, que lo diga él.
    return archivo.subarray(8, 10).toString('latin1') === 'qt' ? 'video/quicktime' : 'video/mp4';
  }

  throw new ValidationError('Sube un video en MP4, MOV o WebM.');
}

async function escribirVideo(id, archivo) {
  await fs.mkdir(env.resenasDir, { recursive: true });
  await fs.writeFile(rutaDelVideo(id), archivo);
}

/** Borra el archivo sin quejarse si ya no estaba. */
async function borrarVideo(id) {
  await fs.rm(rutaDelVideo(id), { force: true });
}

const resenaService = {
  /**
   * Las aprobadas, para la web.
   *
   * `soloDestacadas` es lo que pide la portada, que tiene sitio para unas
   * pocas. El resumen —media y total— se calcula SIEMPRE sobre todas las
   * aprobadas, también cuando se piden solo las destacadas: si se contara
   * sobre las cuatro elegidas a mano, la portada anunciaría un 5,0 que solo
   * dice a quién se eligió.
   *
   * SI NADIE HA DESTACADO NINGUNA, la portada recibe las últimas aprobadas.
   * Destacar es para elegir cuáles de muchas, no un interruptor que hay que
   * acordarse de subir: mientras nadie lo tocaba, la banda de testimonios no
   * existía aunque hubiera reseñas publicadas en /resenas, y eso no se ve como
   * un paso pendiente del panel, se ve como que nadie ha opinado nunca.
   */
  async publicas({ soloDestacadas = false, limite = 100 } = {}) {
    // Con texto o con video. Una fila sin ninguna de las dos cosas —se puede
    // dar de alta desde el panel a la espera del video— no pinta una tarjeta
    // vacía en la portada mientras tanto.
    const CON_ALGO_QUE_ENSENAR = { OR: [{ videoBytes: { gt: 0 } }, { NOT: { comentario: '' } }] };

    const ultimas = (where) =>
      prisma.resenaServicio.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limite,
        select: CAMPOS_PUBLICOS,
      });

    const [elegidas, resumen] = await Promise.all([
      ultimas({
        estado: 'APROBADA',
        ...CON_ALGO_QUE_ENSENAR,
        ...(soloDestacadas ? { destacada: true } : {}),
      }),
      prisma.resenaServicio.aggregate({
        // La misma condición que la lista: la media y el «sobre N reseñas» no
        // pueden contar filas que no se enseñan en ningún sitio. Anunciar «5,0
        // sobre 2 reseñas» encima de una banda sin ninguna tarjeta es peor que
        // no anunciar nada.
        where: { estado: 'APROBADA', ...CON_ALGO_QUE_ENSENAR },
        _count: { _all: true },
        _sum: { estrellas: true },
      }),
    ]);

    const total = resumen._count._all;
    // La segunda consulta solo sale cuando hay algo que encontrar: sin ninguna
    // aprobada, el respaldo devolvería la misma lista vacía por otro camino.
    const filas =
      soloDestacadas && elegidas.length === 0 && total > 0
        ? await ultimas({ estado: 'APROBADA', ...CON_ALGO_QUE_ENSENAR })
        : elegidas;

    return {
      resenas: filas.map(comoSeVe),
      total,
      nota: media(resumen._sum.estrellas ?? 0, total),
    };
  },

  /** La suya, con su estado. Null si nunca escribió ninguna. */
  async mia(userId) {
    const fila = await prisma.resenaServicio.findUnique({
      where: { userId },
      select: CAMPOS_PROPIOS,
    });
    // Con la firma ya calculada: así ve, antes de enviarla, con qué va a salir.
    return fila && comoSeVe(fila);
  },

  /**
   * Guarda la reseña de quien la escribe. Crea la suya o reescribe la que ya
   * tenía, y en los dos casos la deja PENDIENTE.
   *
   * El motivo de un rechazo anterior se borra al reescribirla: si no, se le
   * quedaría en pantalla al autor el «no salió porque…» de una versión que ya
   * cambió.
   */
  async guardar(userId, { estrellas, comentario, oficio }) {
    // Una reseña puede ser SOLO VIDEO: entonces el texto sobra, porque el
    // testimonio es la grabación. Sin video, el texto es obligatorio, que cinco
    // estrellas sueltas no le cuentan nada a quien está decidiendo si compra.
    const suya = await prisma.resenaServicio.findUnique({
      where: { userId },
      select: { videoBytes: true },
    });
    if (comentario.length < 20 && !(suya?.videoBytes > 0)) {
      throw new ValidationError('Cuéntanos cómo te fue, con al menos una frase, o sube tu video.');
    }

    const campos = {
      estrellas,
      comentario,
      oficio,
      estado: 'PENDIENTE',
      motivo: '',
      destacada: false,
      revisadaPorId: null,
      revisadaAt: null,
    };

    // `nombre` ya no se pide ni se enseña: la reseña se firma con el correo
    // tapado. Se guarda el de la cuenta porque la columna es obligatoria y
    // porque el panel necesita saber de quién es sin ir a buscarlo, y solo al
    // crearla: reescribirla no tiene por qué pisar lo que firmó en su día.
    const quien = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });
    const suNombre = [quien?.firstName, quien?.lastName].filter(Boolean).join(' ').slice(0, 120);

    const resena = await prisma.resenaServicio.upsert({
      where: { userId },
      create: { userId, ...campos, nombre: suNombre },
      update: campos,
      select: CAMPOS_PROPIOS,
    });

    // Sin el texto ni el nombre: el tópico de ntfy no es privado (ver lib/notify).
    avisarAlAdmin({
      titulo: 'Una reseña esperando',
      mensaje: `${estrellas} de 5 estrellas. No se ve en la web hasta que la apruebes.`,
      etiquetas: ['star'],
      enlace: `${env.APP_URL}/admin`,
    });

    logger.info({ userId, estrellas }, 'Reseña del servicio guardada, pendiente de aprobar');

    return comoSeVe(resena);
  },

  /** El panel: todas, o las de un estado. La más reciente primero. */
  async listar(estado) {
    const filas = await prisma.resenaServicio.findMany({
      where: estado === 'TODAS' ? {} : { estado },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: CAMPOS_PANEL,
    });
    // Con la firma, para que el panel vea exactamente lo que va a salir en la
    // web, y con el correo entero al lado, que es lo que allí hace falta.
    return filas.map(comoLaVeElPanel);
  },

  /** Cuántas esperan. Es el contador de la barra lateral del panel. */
  async pendientes() {
    return prisma.resenaServicio.count({ where: { estado: 'PENDIENTE' } });
  },

  /**
   * Aprobar, rechazar o destacar, desde el panel.
   *
   * Destacar obliga a que esté aprobada, y se comprueba contra lo que va a
   * quedar guardado y no contra lo que había: en la misma llamada se puede
   * aprobar y destacar, y mirar el estado anterior rechazaría esa combinación
   * por un orden de lectura, no por un motivo.
   *
   * Dejar de estar aprobada baja la destacada. Una reseña que se retira de
   * /resenas no puede seguir en la portada, que es el sitio más visible de los
   * dos.
   */
  async revisar(id, cambios, adminId) {
    const actual = await prisma.resenaServicio.findUnique({
      where: { id },
      select: { id: true, estado: true, destacada: true },
    });
    if (!actual) throw new NotFoundError('Esa reseña no existe.');

    const estado = cambios.estado ?? actual.estado;
    const destacada = (cambios.destacada ?? actual.destacada) && estado === 'APROBADA';

    const resena = await prisma.resenaServicio.update({
      where: { id },
      data: {
        estado,
        destacada,
        ...(cambios.motivo === undefined ? {} : { motivo: cambios.motivo }),
        revisadaPorId: adminId,
        revisadaAt: new Date(),
      },
      select: CAMPOS_PANEL,
    });

    logger.info({ id, estado, destacada, adminId }, 'Reseña del servicio revisada');

    return comoLaVeElPanel(resena);
  },

  // ── El video ──────────────────────────────────────────────────────────────

  /**
   * Guarda el video de una reseña, o lo cambia por otro.
   *
   * Primero el disco y luego la fila: al revés, un fallo al escribir dejaría
   * una reseña que promete un video que no existe, y la web pintaría un
   * reproductor negro.
   *
   * Subir un video NO devuelve la reseña a pendiente por sí solo —eso lo hace
   * reescribir el texto—, pero sí la retira de la web mientras nadie lo haya
   * visto: lo que se aprobó era un texto, no una grabación que nadie miró.
   */
  async guardarVideo(id, archivo, { aRevisar = true } = {}) {
    const actual = await prisma.resenaServicio.findUnique({
      where: { id },
      select: { id: true, estado: true },
    });
    if (!actual) throw new NotFoundError('Esa reseña no existe.');

    const videoTipo = tipoDelVideo(archivo);
    await escribirVideo(id, archivo);

    const resena = await prisma.resenaServicio.update({
      where: { id },
      data: {
        videoBytes: archivo.length,
        videoTipo,
        // Lo que se aprobó era un texto, no una grabación que nadie ha visto.
        // Cuando el video lo sube el propio panel esto no aplica: lo está
        // subiendo justo quien tendría que revisarlo.
        ...(aRevisar ? { estado: 'PENDIENTE', destacada: false, motivo: '' } : {}),
      },
      select: CAMPOS_PROPIOS,
    });

    if (!aRevisar) {
      logger.info({ id, bytes: archivo.length, videoTipo }, 'Video de reseña subido desde el panel');
      return comoSeVe(resena);
    }

    avisarAlAdmin({
      titulo: 'Un video de reseña esperando',
      mensaje: 'Míralo antes de aprobarlo. No se ve en la web hasta entonces.',
      etiquetas: ['clapper'],
      enlace: `${env.APP_URL}/admin`,
    });

    logger.info({ id, bytes: archivo.length, videoTipo }, 'Video de reseña guardado');

    return comoSeVe(resena);
  },

  /** Quita el video y deja la reseña con lo que tenga escrito. */
  async quitarVideo(id) {
    const actual = await prisma.resenaServicio.findUnique({
      where: { id },
      select: { id: true, comentario: true },
    });
    if (!actual) throw new NotFoundError('Esa reseña no existe.');
    if (actual.comentario.trim().length < 20) {
      throw new ValidationError(
        'Sin el video, esa reseña se queda sin nada que enseñar. Escribe el texto antes de quitarlo.',
      );
    }

    await borrarVideo(id);
    const resena = await prisma.resenaServicio.update({
      where: { id },
      data: { videoBytes: 0, videoTipo: '' },
      select: CAMPOS_PROPIOS,
    });

    return comoSeVe(resena);
  },

  /**
   * Dónde está el archivo, para servirlo.
   *
   * `soloAprobadas` es lo que pide la web pública: un video pendiente no se ve
   * en ningún sitio. Su autor y el panel lo miran con esto en falso, que para
   * eso hay que poder revisarlo antes de aprobarlo.
   */
  async paraVer(id, { soloAprobadas = true } = {}) {
    const fila = await prisma.resenaServicio.findUnique({
      where: { id },
      select: { id: true, estado: true, videoBytes: true, videoTipo: true },
    });
    if (!fila || fila.videoBytes === 0) throw new NotFoundError('Esa reseña no tiene video.');
    if (soloAprobadas && fila.estado !== 'APROBADA') {
      throw new NotFoundError('Esa reseña no tiene video.');
    }

    return { ruta: rutaDelVideo(id), tipo: fila.videoTipo || 'video/mp4' };
  },

  /**
   * Una reseña escrita desde el panel, a nombre de un cliente.
   *
   * Existe porque los testimonios llegan por WhatsApp y por correo, no por el
   * formulario: quien graba un video contando cómo le fue no vuelve luego a la
   * web a escribirlo. Se apunta el correo del cliente, y la firma pública sale
   * de ahí igual que las demás, así que sigue siendo verificable.
   *
   * NO INVENTA CLIENTES: si ese correo no tiene cuenta, no se crea nada. Un
   * testimonio de alguien que no existe es exactamente lo que esto no es.
   *
   * Nace APROBADA porque la escribe quien aprueba. Destacarla es aparte.
   */
  async crearDesdeElPanel({ email, estrellas, comentario, oficio }, adminId) {
    const cliente = await prisma.user.findUnique({
      where: { email },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!cliente) {
      throw new NotFoundError('No hay ninguna cuenta con ese correo. La reseña tiene que ser de un cliente.');
    }

    const nombre = [cliente.firstName, cliente.lastName].filter(Boolean).join(' ').slice(0, 120);
    const campos = {
      estrellas,
      comentario,
      oficio,
      estado: 'APROBADA',
      motivo: '',
      revisadaPorId: adminId,
      revisadaAt: new Date(),
    };

    const resena = await prisma.resenaServicio.upsert({
      where: { userId: cliente.id },
      create: { userId: cliente.id, ...campos, nombre },
      update: campos,
      select: CAMPOS_PANEL,
    });

    logger.info({ id: resena.id, adminId }, 'Reseña del servicio dada de alta desde el panel');

    return comoLaVeElPanel(resena);
  },
};

module.exports = resenaService;
