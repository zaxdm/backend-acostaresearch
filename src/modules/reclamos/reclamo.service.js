'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { sendMail } = require('../../lib/mailer');
const { avisarAlAdmin } = require('../../lib/notify');
const {
  reclamoRegistrado,
  reclamoRecibidoAdmin,
  reclamoRespondido,
} = require('../../lib/emailTemplates');
const { ConflictError, NotFoundError } = require('../../shared/errors/AppError');
const { codigoDeHoja, fechaEnLima, sumarDiasHabiles } = require('./reclamo.plazo');

/**
 * El Libro de Reclamaciones virtual.
 *
 * Lo exige el Código de Protección y Defensa del Consumidor a quien vende a
 * consumidores en el Perú, y su reglamento (D.S. 011-2011-PCM) fija lo que
 * lleva cada hoja: número correlativo, datos del proveedor y del consumidor, lo
 * que se contrató, el detalle, el pedido y la respuesta. El consumidor recibe
 * copia en el momento —aquí, por correo— y la respuesta tiene quince días
 * hábiles de plazo.
 *
 * LO QUE SE ESCRIBE NO SE REESCRIBE
 * ---------------------------------
 * Ni la hoja ni su respuesta se editan o se borran desde la aplicación. Es un
 * libro: vale ante INDECOPI porque lo que dice hoy es lo que decía el día en que
 * se escribió. Tampoco cuelga de ninguna cuenta, así que borrar una cuenta no se
 * lleva sus hojas, que el reglamento manda conservar.
 */

const TIPO = { RECLAMO: 'Reclamo', QUEJA: 'Queja' };

/** Quién responde. Encabeza la hoja en la web y en los correos. */
function proveedor() {
  return {
    razonSocial: env.RECLAMOS_RAZON_SOCIAL,
    ruc: env.RECLAMOS_RUC ?? null,
    domicilio: env.RECLAMOS_DOMICILIO,
  };
}

const salida = (fila) => ({
  ...fila,
  codigo: codigoDeHoja(fila.numero, fila.createdAt),
  montoReclamado: fila.montoReclamado === null ? null : Number(fila.montoReclamado),
  respondido: fila.respondidoAt !== null,
});

/** El mismo criterio que el aviso de Yape: la variable, o el primer administrador activo. */
async function correoDelAdministrador() {
  if (env.ADMIN_NOTIFY_EMAIL) return env.ADMIN_NOTIFY_EMAIL;

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { email: true },
  });
  return admin?.email ?? null;
}

/**
 * Manda un correo sin que su fallo deshaga nada.
 *
 * La hoja ya está en el libro cuando se intenta el correo. Si Brevo falla, la
 * hoja sigue existiendo y el plazo sigue corriendo: tirar la petición por eso
 * haría creer al consumidor que no reclamó, y lo volvería a intentar con otro
 * número.
 */
async function enviar(destino, correo, contexto) {
  try {
    await sendMail({ to: destino, ...correo });
    return true;
  } catch (error) {
    logger.error({ err: error, ...contexto }, 'No salió un correo del Libro de Reclamaciones');
    return false;
  }
}

const reclamoService = {
  proveedor,

  async registrar(datos) {
    const ahora = new Date();

    const fila = await prisma.reclamo.create({
      data: {
        tipo: datos.tipo,
        nombre: datos.nombre,
        tipoDocumento: datos.tipoDocumento,
        numeroDocumento: datos.numeroDocumento,
        domicilio: datos.domicilio,
        telefono: datos.telefono || null,
        email: datos.email,
        apoderado: datos.menorDeEdad ? datos.apoderado : null,
        tipoBien: datos.tipoBien,
        montoReclamado: datos.montoReclamado,
        descripcionBien: datos.descripcionBien,
        detalle: datos.detalle,
        pedido: datos.pedido,
        fechaLimite: sumarDiasHabiles(ahora),
        createdAt: ahora,
      },
    });

    const reclamo = salida(fila);
    const fechaTexto = fechaEnLima(reclamo.createdAt, { conHora: true });
    const limiteTexto = fechaEnLima(reclamo.fechaLimite);

    const correoEnviado = await enviar(
      reclamo.email,
      reclamoRegistrado({ reclamo, proveedor: proveedor(), fechaTexto, limiteTexto }),
      { numero: reclamo.numero },
    );

    // Al administrador, sin esperar: el consumidor ya tiene su copia y no tiene
    // por qué aguardar a este segundo correo.
    correoDelAdministrador()
      .then((destino) => {
        if (destino) {
          return enviar(destino, reclamoRecibidoAdmin({ reclamo, fechaTexto, limiteTexto }), {
            numero: reclamo.numero,
          });
        }
        logger.warn({ numero: reclamo.numero }, 'Hoja de reclamación sin administrador a quien avisar');
        return null;
      })
      .catch((error) => logger.error({ err: error }, 'No se pudo avisar de una hoja de reclamación'));

    // Sin nombre ni correo: el tópico de ntfy no es privado (ver lib/notify).
    avisarAlAdmin({
      titulo: `${TIPO[reclamo.tipo]} en el Libro de Reclamaciones`,
      mensaje: `Hoja Nº ${reclamo.codigo}. Hay que responder antes del ${limiteTexto}.`,
      etiquetas: ['warning'],
      prioridad: 4,
      enlace: `${env.APP_URL}/admin`,
    });

    logger.info({ numero: reclamo.numero, tipo: reclamo.tipo }, 'Hoja de reclamación registrada');

    return { reclamo, correoEnviado };
  },

  async listar() {
    const filas = await prisma.reclamo.findMany({ orderBy: { numero: 'desc' }, take: 500 });
    return filas.map(salida);
  },

  /**
   * La respuesta del proveedor. Una sola vez.
   *
   * Se escribe con `updateMany` condicionado a que siga sin respuesta, y no
   * leyendo y luego escribiendo: con dos administradores respondiendo a la vez,
   * el segundo pisaría al primero y al consumidor le llegarían dos respuestas
   * distintas a la misma hoja.
   */
  async responder(numero, respuesta, adminId) {
    const existe = await prisma.reclamo.findUnique({ where: { numero }, select: { numero: true } });
    if (!existe) throw new NotFoundError('Esa hoja de reclamación no existe.');

    const { count } = await prisma.reclamo.updateMany({
      where: { numero, respondidoAt: null },
      data: { respuesta, respondidoAt: new Date(), respondidoPorId: adminId },
    });
    if (count === 0) {
      throw new ConflictError(
        'Esta hoja ya tiene respuesta. Lo que se contesta en el Libro no se reescribe: si hay algo ' +
          'que añadir, escríbele al consumidor por correo.',
      );
    }

    const reclamo = salida(await prisma.reclamo.findUnique({ where: { numero } }));

    const correoEnviado = await enviar(
      reclamo.email,
      reclamoRespondido({
        reclamo,
        proveedor: proveedor(),
        fechaTexto: fechaEnLima(reclamo.createdAt),
        respuestaTexto: fechaEnLima(reclamo.respondidoAt, { conHora: true }),
      }),
      { numero },
    );

    logger.info({ numero, adminId, correoEnviado }, 'Hoja de reclamación respondida');

    return { reclamo, correoEnviado };
  },
};

module.exports = reclamoService;
