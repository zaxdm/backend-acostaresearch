'use strict';

/**
 * Las consultas de «Preparar documento».
 *
 * La que importa es `usadosEn`: el cupo del mes no es una columna que se
 * decrementa, es esta cuenta. Ver `preparar.membresia` para por qué.
 */

const prisma = require('../../lib/prisma');

/** Lo que se le enseña al cliente de cada trabajo suyo. */
const preparacionSelect = {
  id: true,
  servicio: true,
  idioma: true,
  nombre: true,
  palabras: true,
  estado: true,
  error: true,
  tocados: true,
  intactos: true,
  createdAt: true,
  entregadoAt: true,
};

const packSelect = {
  id: true,
  docsPorMes: true,
  status: true,
  activatedAt: true,
  expiresAt: true,
  plan: { select: { code: true, name: true, durationDays: true } },
};

const prepararRepository = {
  preparacionSelect,
  packSelect,

  /**
   * La membresía que vale hoy.
   *
   * La que más tarde caduca, no la más reciente: quien renueva antes de tiempo
   * alarga la que tiene (ver `prepararParaCompra`), pero si por lo que sea
   * acabara con dos, la buena es la que cubre más.
   *
   * Las revocadas no entran. Las caducadas sí: hace falta poder decir «tu
   * membresía caducó» en vez de «no tienes ninguna», que es otra conversación.
   */
  membresiaDe(userId, tx = prisma) {
    return tx.docPack.findFirst({
      where: { userId, status: { not: 'REVOKED' } },
      orderBy: { expiresAt: 'desc' },
      select: packSelect,
    });
  },

  /** La misma, entera, para tocarla. */
  packVigenteDe(userId, tx = prisma) {
    return tx.docPack.findFirst({
      where: { userId, status: { not: 'REVOKED' } },
      orderBy: { expiresAt: 'desc' },
    });
  },

  /**
   * Cuántos documentos gastó en esta ventana.
   *
   * Las FALLIDAS no cuentan: lo que no salió no se cobra, ni en dinero ni en
   * cupo. Las que están en cola o en curso SÍ cuentan, porque si no, quien
   * mande diez a la vez se saltaría el tope mientras ninguna ha terminado.
   */
  usadosEn(docPackId, desde, hasta, tx = prisma) {
    return tx.preparacion.count({
      where: {
        docPackId,
        estado: { not: 'FALLIDO' },
        createdAt: { gte: desde, lt: hasta },
      },
    });
  },

  crear(data, tx = prisma) {
    return tx.preparacion.create({ data, select: preparacionSelect });
  },

  /** Cambia el estado de un trabajo. Lo llama el motor mientras avanza. */
  marcar(id, data, tx = prisma) {
    return tx.preparacion.update({ where: { id }, data, select: preparacionSelect });
  },

  /** Un trabajo, solo si es de quien lo pide. Nadie descarga el Word de otro. */
  mia(userId, id, tx = prisma) {
    return tx.preparacion.findFirst({ where: { id, userId }, select: preparacionSelect });
  },

  /**
   * De quién es un trabajo, con su correo.
   *
   * Aparte de `preparacionSelect` a propósito: eso es lo que se le devuelve al
   * cliente por la API y no tiene por qué llevar identificadores de cuenta.
   * Esto lo usa el motor para avisar por correo al terminar.
   */
  duenoDe(id, tx = prisma) {
    return tx.preparacion.findUnique({
      where: { id },
      select: { user: { select: { id: true, email: true, firstName: true } } },
    });
  },

  listarDe(userId, { limite = 50 } = {}, tx = prisma) {
    return tx.preparacion.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limite,
      select: preparacionSelect,
    });
  },

  buscarPack(id, tx = prisma) {
    return tx.docPack.findUnique({ where: { id }, select: packSelect });
  },

  crearPack(data, tx = prisma) {
    return tx.docPack.create({ data });
  },

  /** Renovar: se alarga la que ya tiene. `activatedAt` NO se toca. */
  extenderPack(id, { expiresAt, docsPorMes }, tx = prisma) {
    return tx.docPack.update({
      where: { id },
      data: { expiresAt, docsPorMes, status: 'ACTIVE' },
    });
  },

  /** Para el panel del administrador: las últimas membresías vendidas. */
  listarPacksRecientes({ limite = 50 } = {}, tx = prisma) {
    return tx.docPack.findMany({
      orderBy: { createdAt: 'desc' },
      take: limite,
      select: {
        ...packSelect,
        createdAt: true,
        amountCents: true,
        paymentMethod: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
  },
};

module.exports = prepararRepository;
