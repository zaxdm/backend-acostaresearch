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
 * VARIAS POR CUENTA
 * -----------------
 * Quien vuelve a los seis meses con otra fase terminada tiene algo distinto que
 * contar, así que escribe otra. Cambiar una que ya dejó la devuelve a
 * PENDIENTE: si no, bastaría con dejar una reseña educada, esperar a que se
 * apruebe y luego cambiarle el texto. Hay un tope por cuenta para que esto no
 * se convierta en un tablón.
 *
 * LAS DEL PANEL NO SON SUYAS
 * --------------------------
 * Una reseña que dio de alta el administrador a nombre de alguien lleva
 * `delPanel` y su titular NO la puede tocar: no la escribió él, así que no le
 * cambia el texto, ni el video, ni se lo quita. Lo que sí puede es escribir la
 * suya, que es otra fila.
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
  correo: true,
  // Entra para saber si detrás hay una cuenta; el identificador no sale de
  // `comoSeVe()`, solo el sí o el no.
  userId: true,
  // Sale fuera porque /resenas la marca: son las que elegimos para la portada,
  // y no es ningún secreto —cualquiera las ve ahí—. Nada más de la moderación
  // se asoma: ni el estado, ni el motivo de un rechazo, ni quién la revisó.
  destacada: true,
};

/** Lo que ve su autor: lo suyo, más en qué punto está. */
const CAMPOS_PROPIOS = {
  ...CAMPOS_PUBLICOS,
  estado: true,
  motivo: true,
  delPanel: true,
  updatedAt: true,
};

/** Lo que ve el panel. Añade de quién es, que es lo que allí hace falta. */
const CAMPOS_PANEL = {
  ...CAMPOS_PROPIOS,
  nombre: true,
  revisadaAt: true,
  // Nulo en las que se dieron de alta a nombre de alguien sin cuenta.
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
 *
 * `conCuenta` es lo que sostiene a la firma: dice que detrás de ese correo
 * tapado hay una cuenta de verdad, no un testimonio apuntado a mano desde el
 * panel. La web lo enseña al lado del correo, y por eso tiene que salir: sin
 * él, las dos clases de reseña se verían exactamente igual. El identificador
 * del usuario NO sale —entra aquí solo para calcular esto y se queda dentro—.
 */
function comoSeVe({ user, userId, correo, videoBytes, videoTipo, ...resto }) {
  return {
    ...resto,
    autor: firma(correo),
    video: videoBytes > 0,
    conCuenta: Boolean(userId ?? user),
  };
}

/**
 * Como la ve el panel: lo mismo, más de quién es y el correo ENTERO.
 *
 * Aquí sí va entero, que es lo que hace falta para saber a quién escribir. Y
 * `sinCuenta` porque una firma sin cuenta detrás vale menos y hay que verlo de
 * un vistazo, no deduciéndolo de que falte un nombre.
 */
function comoLaVeElPanel(fila) {
  return {
    ...comoSeVe(fila),
    correo: fila.correo,
    user: fila.user ?? null,
    sinCuenta: fila.user === null || fila.user === undefined,
  };
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
 * Cuántas puede dejar una misma cuenta.
 *
 * Varias sí —quien vuelve con otra fase terminada tiene algo distinto que
 * contar—, pero no las que quiera: cada una pasa por moderación a mano, y diez
 * por cuenta es más de lo que nadie tiene que decir sin que esto se convierta
 * en un tablón.
 */
const MAXIMO_POR_CUENTA = 10;

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

  /** Las suyas, las últimas primero. Vacío si nunca escribió ninguna. */
  async mias(userId) {
    const filas = await prisma.resenaServicio.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: CAMPOS_PROPIOS,
    });
    // Con la firma ya calculada: así ve, antes de enviarla, con qué va a salir.
    return filas.map(comoSeVe);
  },

  /**
   * Una de las suyas, comprobando que lo sea y que la pueda tocar.
   *
   * Lo que devuelve es la fila cruda, para quien va a escribir encima. Las del
   * panel se paran aquí: su titular no las escribió, así que no las cambia.
   */
  async suya(id, userId) {
    const fila = await prisma.resenaServicio.findUnique({
      where: { id },
      select: { id: true, userId: true, delPanel: true, videoBytes: true, comentario: true },
    });
    if (!fila || fila.userId !== userId) throw new NotFoundError('Esa reseña no existe.');
    if (fila.delPanel) {
      throw new ValidationError(
        'Esa reseña la publicamos nosotros con lo que nos contaste. Escríbenos si quieres cambiarla o quitarla.',
      );
    }
    return fila;
  },

  /**
   * Escribe una reseña nueva, o cambia una que ya dejó. En los dos casos queda
   * PENDIENTE: si no, bastaría con dejar una educada, esperar a que se apruebe
   * y luego cambiarle el texto.
   *
   * El motivo de un rechazo anterior se borra al cambiarla: si no, se le
   * quedaría en pantalla al autor el «no salió porque…» de una versión que ya
   * cambió.
   *
   * `id` = está cambiando una suya. Sin `id`, estrena fila: varias por cuenta,
   * porque quien vuelve a los seis meses con otra fase terminada tiene algo
   * distinto que contar.
   */
  async guardar(userId, { estrellas, comentario, oficio, conVideo = false }, id = null) {
    // Solo puede quedarse sin texto la que ya tiene video, o la que lo trae
    // detrás (`conVideo`): entonces el testimonio es la grabación. Sin video, el
    // texto es obligatorio, que cinco estrellas sueltas no le cuentan nada a
    // quien está decidiendo si compra.
    const actual = id ? await this.suya(id, userId) : null;
    if (comentario.length < 20 && !(actual?.videoBytes > 0) && !conVideo) {
      throw new ValidationError('Cuéntanos cómo te fue, con al menos una frase, o sube tu video.');
    }

    if (!id) {
      const cuantas = await prisma.resenaServicio.count({ where: { userId } });
      if (cuantas >= MAXIMO_POR_CUENTA) {
        throw new ValidationError(
          `Ya has dejado ${MAXIMO_POR_CUENTA} reseñas. Cambia alguna de las que tienes en lugar de escribir otra.`,
        );
      }
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

    let resena;
    if (id) {
      resena = await prisma.resenaServicio.update({
        where: { id },
        data: campos,
        select: CAMPOS_PROPIOS,
      });
    } else {
      // `nombre` y `correo` se copian de la cuenta al crearla. El nombre no se
      // enseña —la firma es el correo tapado—, pero el panel necesita saber de
      // quién es sin ir a buscarlo, y el correo va en la fila para que la firma
      // no dependa de que el usuario siga existiendo.
      const quien = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, lastName: true },
      });
      const suNombre = [quien?.firstName, quien?.lastName].filter(Boolean).join(' ').slice(0, 120);

      resena = await prisma.resenaServicio.create({
        data: { userId, ...campos, nombre: suNombre, correo: quien?.email ?? '' },
        select: CAMPOS_PROPIOS,
      });
    }

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
   * web a escribirlo. Se apunta el correo y la firma pública sale de ahí, igual
   * que en las demás.
   *
   * SI ESE CORREO NO TIENE CUENTA SE GUARDA IGUAL, Y SE AVISA. Hay quien compró
   * por otra vía y no tiene cuenta en la web, y su testimonio es tan real como
   * el resto; pero una firma sin cuenta detrás no se puede comprobar, así que
   * quien la publica tiene que saberlo en ese momento y no descubrirlo después.
   * Por eso vuelve `sinCuenta`, que el panel enseña.
   *
   * Nace APROBADA porque la escribe quien aprueba, y marcada con `delPanel`:
   * su titular no la escribió, así que no la puede tocar.
   */
  async crearDesdeElPanel({ email, estrellas, comentario, oficio }, adminId) {
    const cliente = await prisma.user.findUnique({
      where: { email },
      select: { id: true, firstName: true, lastName: true },
    });

    const nombre = cliente
      ? [cliente.firstName, cliente.lastName].filter(Boolean).join(' ').slice(0, 120)
      : '';

    const resena = await prisma.resenaServicio.create({
      data: {
        userId: cliente?.id ?? null,
        correo: email,
        nombre,
        delPanel: true,
        estrellas,
        comentario,
        oficio,
        estado: 'APROBADA',
        motivo: '',
        revisadaPorId: adminId,
        revisadaAt: new Date(),
      },
      select: CAMPOS_PANEL,
    });

    logger.info(
      { id: resena.id, adminId, sinCuenta: !cliente },
      'Reseña del servicio dada de alta desde el panel',
    );

    return comoLaVeElPanel(resena);
  },

  /**
   * La borra del todo: la fila y su video.
   *
   * NO ES LO MISMO QUE RECHAZARLA
   * -----------------------------
   * Rechazar la retira de la web y la deja donde está, con su motivo, porque
   * detrás hay alguien que escribió algo y puede corregirlo y volver a
   * enviarlo. Esto es para lo que nunca fue una reseña: las de prueba, las que
   * se dieron de alta con el correo equivocado, las que quedaron en blanco
   * esperando un video que no llegó. Ahí no hay a quién responder ni nada que
   * conservar, y rechazarlas solo las escondía: seguían contando en el panel y
   * en el perfil de su supuesto autor.
   *
   * Primero la fila y luego el disco: al revés, si fallara el borrado de la
   * fila quedaría una reseña prometiendo un video que ya no está, que es
   * exactamente lo que la web no sabe pintar.
   */
  async borrar(id, adminId) {
    const fila = await prisma.resenaServicio.findUnique({
      where: { id },
      select: { id: true, videoBytes: true },
    });
    if (!fila) throw new NotFoundError('Esa reseña no existe.');

    await prisma.resenaServicio.delete({ where: { id } });
    if (fila.videoBytes > 0) await borrarVideo(id);

    logger.info({ id, adminId }, 'Reseña del servicio borrada desde el panel');

    return { id };
  },
};

module.exports = resenaService;
