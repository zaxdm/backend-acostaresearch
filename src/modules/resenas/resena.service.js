'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { avisarAlAdmin } = require('../../lib/notify');
const { NotFoundError } = require('../../shared/errors/AppError');

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
 * LO PÚBLICO NO LLEVA CORREO
 * --------------------------
 * Las consultas de fuera seleccionan campo por campo y el correo no está entre
 * ellos. No es descuido evitado: es que la fila cuelga de un usuario, y un
 * `include: { user: true }` distraído repartiría la lista de correos de los
 * clientes en una página pública.
 */

/** Lo que se enseña de una reseña a cualquiera. Sin correo y sin userId. */
const CAMPOS_PUBLICOS = {
  id: true,
  estrellas: true,
  comentario: true,
  nombre: true,
  oficio: true,
  createdAt: true,
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
  revisadaAt: true,
  user: { select: { id: true, email: true, firstName: true, lastName: true } },
};

/** La media, redondeada a un decimal. Null sin ninguna: no hay media de nada. */
function media(suma, cuantas) {
  return cuantas === 0 ? null : Math.round((suma / cuantas) * 10) / 10;
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
   */
  async publicas({ soloDestacadas = false, limite = 100 } = {}) {
    const [filas, resumen] = await Promise.all([
      prisma.resenaServicio.findMany({
        where: { estado: 'APROBADA', ...(soloDestacadas ? { destacada: true } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limite,
        select: CAMPOS_PUBLICOS,
      }),
      prisma.resenaServicio.aggregate({
        where: { estado: 'APROBADA' },
        _count: { _all: true },
        _sum: { estrellas: true },
      }),
    ]);

    const total = resumen._count._all;
    return { resenas: filas, total, nota: media(resumen._sum.estrellas ?? 0, total) };
  },

  /** La suya, con su estado. Null si nunca escribió ninguna. */
  async mia(userId) {
    return prisma.resenaServicio.findUnique({ where: { userId }, select: CAMPOS_PROPIOS });
  },

  /**
   * Guarda la reseña de quien la escribe. Crea la suya o reescribe la que ya
   * tenía, y en los dos casos la deja PENDIENTE.
   *
   * El motivo de un rechazo anterior se borra al reescribirla: si no, se le
   * quedaría en pantalla al autor el «no salió porque…» de una versión que ya
   * cambió.
   */
  async guardar(userId, { estrellas, comentario, nombre, oficio }) {
    const campos = {
      estrellas,
      comentario,
      nombre,
      oficio,
      estado: 'PENDIENTE',
      motivo: '',
      destacada: false,
      revisadaPorId: null,
      revisadaAt: null,
    };

    const resena = await prisma.resenaServicio.upsert({
      where: { userId },
      create: { userId, ...campos },
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

    return resena;
  },

  /** El panel: todas, o las de un estado. La más reciente primero. */
  async listar(estado) {
    return prisma.resenaServicio.findMany({
      where: estado === 'TODAS' ? {} : { estado },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: CAMPOS_PANEL,
    });
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

    return resena;
  },
};

module.exports = resenaService;
