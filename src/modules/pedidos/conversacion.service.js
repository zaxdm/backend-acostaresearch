'use strict';

const prisma = require('../../lib/prisma');
const { NotFoundError, ConflictError } = require('../../shared/errors/AppError');
const {
  comprobarDocx,
  nombreLimpio,
  guardar,
  rutaDelMensaje,
} = require('./documento');

/**
 * Lo que se dicen el tesista y su asesor dentro de un encargo.
 *
 * POR QUÉ DENTRO Y NO POR WHATSAPP
 * --------------------------------
 * Porque fuera se pierde. Lo que se acordó, la duda que resolvió media
 * metodología, la versión que se mandó el martes: si vive en un chat de móvil,
 * el día que haya que mirarlo no está, y quien reclama y quien responde cuentan
 * dos historias distintas. Aquí queda, con su fecha y su autor.
 *
 * Y porque es lo que convierte esto en un servicio y no en un buzón. Entregar
 * tu tesis a un desconocido y pasar tres días sin saber nada no es esperar, es
 * desconfiar.
 *
 * CUÁNDO SE PUEDE HABLAR
 * ----------------------
 * Desde que el asesor acepta. Antes no: mientras decide no ve el documento ni
 * al tesista —ver `pedido.service`—, y abrir un canal sería la puerta de atrás
 * a lo que la de delante no deja pasar. Después de entregar SÍ se sigue
 * hablando, que es justo cuando el tesista corrige y pregunta.
 */

/** Los estados en los que hay conversación. Ver la nota de arriba. */
const HABLANDO = ['EN_REVISION', 'ENTREGADO'];

const mensajeSelect = {
  id: true,
  de: true,
  texto: true,
  archivoNombre: true,
  bytes: true,
  leidoAt: true,
  createdAt: true,
};

/**
 * El pedido de esta conversación, comprobando quién pregunta.
 *
 * El tesista llega con el código de su pedido; el asesor, con su llave y el
 * identificador. Ninguno de los dos puede leer la conversación del otro.
 */
async function pedidoDe({ codigo, token, pedidoId }) {
  const pedido = codigo
    ? await prisma.pedido.findUnique({
        where: { codigo },
        select: { id: true, estado: true, asesorId: true },
      })
    : await prisma.pedido.findUnique({
        where: { id: pedidoId },
        select: { id: true, estado: true, asesorId: true },
      });

  if (!pedido || pedido.estado === 'CANCELADO') {
    throw new NotFoundError('No encontramos esa conversación.');
  }

  if (token) {
    const asesor = await prisma.asesor.findUnique({
      where: { token },
      select: { id: true, estado: true },
    });
    if (!asesor || asesor.estado !== 'APROBADO' || asesor.id !== pedido.asesorId) {
      throw new NotFoundError('Ese encargo no es tuyo.');
    }
  }

  return pedido;
}

/** Aún no se puede hablar: el asesor todavía no ha dicho que sí. */
function comprobarQueSePuedeHablar(pedido) {
  if (!HABLANDO.includes(pedido.estado)) {
    throw new ConflictError(
      'La conversación se abre cuando el asesor acepta el encargo.',
    );
  }
}

/**
 * La conversación, y de paso se dan por leídos los del otro.
 *
 * Marcar al leer y no al escribir es lo que permite decir «tienes 2 sin leer»
 * sin mentir: lo sella quien los recibe, en el momento en que los tiene
 * delante.
 */
async function leer(pedido, quienMira) {
  const delOtro = quienMira === 'TESISTA' ? 'ASESOR' : 'TESISTA';

  await prisma.mensaje.updateMany({
    where: { pedidoId: pedido.id, de: delOtro, leidoAt: null },
    data: { leidoAt: new Date() },
  });

  const mensajes = await prisma.mensaje.findMany({
    where: { pedidoId: pedido.id },
    orderBy: { createdAt: 'asc' },
    select: mensajeSelect,
  });

  return { abierta: HABLANDO.includes(pedido.estado), mensajes };
}

/**
 * Escribir, con un documento opcional.
 *
 * El adjunto es lo que cierra el ciclo: con las observaciones en la mano, el
 * tesista corrige y vuelve a mandar su versión por aquí, en vez de que la
 * revisión termine sin que nadie compruebe nunca si lo observado se levantó.
 *
 * Primero la fila —que da el identificador— y luego el disco; si el disco
 * falla, la fila se quita, para que no quede un mensaje que promete un archivo
 * que no está.
 */
async function escribir(pedido, de, { texto, archivo, nombreArchivo }) {
  comprobarQueSePuedeHablar(pedido);

  const llevaArchivo = Buffer.isBuffer(archivo) && archivo.length > 0;
  if (llevaArchivo) comprobarDocx(archivo, nombreArchivo);

  const mensaje = await prisma.mensaje.create({
    data: {
      pedidoId: pedido.id,
      de,
      texto,
      archivoNombre: llevaArchivo ? nombreLimpio(nombreArchivo) : '',
      bytes: llevaArchivo ? archivo.length : 0,
    },
    select: mensajeSelect,
  });

  if (llevaArchivo) {
    try {
      await guardar(rutaDelMensaje(mensaje.id), archivo);
    } catch (error) {
      await prisma.mensaje.delete({ where: { id: mensaje.id } }).catch(() => {});
      throw error;
    }
  }

  return mensaje;
}

/** El documento adjunto a un mensaje de esta conversación. */
async function adjunto(pedido, mensajeId) {
  const mensaje = await prisma.mensaje.findUnique({
    where: { id: mensajeId },
    select: { id: true, pedidoId: true, archivoNombre: true, bytes: true },
  });
  if (!mensaje || mensaje.pedidoId !== pedido.id || mensaje.bytes === 0) {
    throw new NotFoundError('Ese mensaje no tiene documento.');
  }

  return { ruta: rutaDelMensaje(mensaje.id), nombre: mensaje.archivoNombre };
}

/**
 * Cuántos sin leer tiene cada pedido, para el lado que mira.
 *
 * En una consulta para todos: pedirlo por pedido serían tantas consultas como
 * encargos, y esto se pinta en una lista.
 */
async function sinLeerPorPedido(pedidoIds, quienMira) {
  if (pedidoIds.length === 0) return new Map();

  const delOtro = quienMira === 'TESISTA' ? 'ASESOR' : 'TESISTA';
  const filas = await prisma.mensaje.groupBy({
    by: ['pedidoId'],
    where: { pedidoId: { in: pedidoIds }, de: delOtro, leidoAt: null },
    _count: { _all: true },
  });

  return new Map(filas.map((fila) => [fila.pedidoId, fila._count._all]));
}

// ── Lo que usan las rutas ───────────────────────────────────────────────────

const comoTesista = {
  async ver(codigo) {
    return leer(await pedidoDe({ codigo }), 'TESISTA');
  },
  async escribir(codigo, datos) {
    const pedido = await pedidoDe({ codigo });
    return escribir(pedido, 'TESISTA', datos);
  },
  async adjunto(codigo, mensajeId) {
    return adjunto(await pedidoDe({ codigo }), mensajeId);
  },
};

const comoAsesor = {
  async ver(token, pedidoId) {
    return leer(await pedidoDe({ token, pedidoId }), 'ASESOR');
  },
  async escribir(token, pedidoId, datos) {
    const pedido = await pedidoDe({ token, pedidoId });
    return escribir(pedido, 'ASESOR', datos);
  },
  async adjunto(token, pedidoId, mensajeId) {
    return adjunto(await pedidoDe({ token, pedidoId }), mensajeId);
  },
};

module.exports = { comoTesista, comoAsesor, sinLeerPorPedido, escribir, pedidoDe, HABLANDO };
