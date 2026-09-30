'use strict';

const prisma = require('../../lib/prisma');

/** Lo que enseña la bandeja de cada conversación, sin sus mensajes. */
const RESUMEN = {
  id: true,
  telefono: true,
  nombre: true,
  modo: true,
  bloqueado: true,
  pideHumano: true,
  noLeidos: true,
  ultimoDelClienteAt: true,
  ultimoMensajeAt: true,
  createdAt: true,
};

const MENSAJE = {
  id: true,
  autor: true,
  texto: true,
  envio: true,
  error: true,
  modelo: true,
  createdAt: true,
};

const whatsappRepository = {
  /** La única fila de ajustes. Se crea con los valores por defecto la primera vez. */
  ajustes() {
    return prisma.whatsappAjustes.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  },

  guardarAjustes(datos) {
    return prisma.whatsappAjustes.upsert({
      where: { id: 1 },
      update: datos,
      create: { id: 1, ...datos },
    });
  },

  porTelefono(telefono) {
    return prisma.whatsappConversacion.findUnique({ where: { telefono }, select: RESUMEN });
  },

  porId(id) {
    return prisma.whatsappConversacion.findUnique({ where: { id }, select: RESUMEN });
  },

  /** Crea la conversación o le anota el mensaje nuevo del cliente. */
  anotarDelCliente(telefono, nombre, ahora = new Date()) {
    return prisma.whatsappConversacion.upsert({
      where: { telefono },
      create: {
        telefono,
        nombre: nombre.slice(0, 120),
        noLeidos: 1,
        ultimoDelClienteAt: ahora,
        ultimoMensajeAt: ahora,
      },
      update: {
        ...(nombre ? { nombre: nombre.slice(0, 120) } : {}),
        noLeidos: { increment: 1 },
        ultimoDelClienteAt: ahora,
        ultimoMensajeAt: ahora,
      },
      select: RESUMEN,
    });
  },

  actualizar(id, datos) {
    return prisma.whatsappConversacion.update({ where: { id }, data: datos, select: RESUMEN });
  },

  guardarMensaje(datos) {
    return prisma.whatsappMensaje.create({ data: datos, select: MENSAJE });
  },

  /** Si ese aviso de Meta ya se procesó. */
  async yaVisto(waId) {
    if (!waId) return false;
    return Boolean(await prisma.whatsappMensaje.findUnique({ where: { waId }, select: { id: true } }));
  },

  /** Los últimos `cuantos` mensajes, del más viejo al más nuevo. */
  async historial(conversacionId, cuantos) {
    const ultimos = await prisma.whatsappMensaje.findMany({
      where: { conversacionId },
      orderBy: { createdAt: 'desc' },
      take: cuantos,
      select: MENSAJE,
    });
    return ultimos.reverse();
  },

  cuantosMensajes(conversacionId) {
    return prisma.whatsappMensaje.count({ where: { conversacionId } });
  },

  /** La bandeja: las más recientes primero, con el último mensaje de cada una. */
  async listar({ filtro, busqueda, limite = 100 }) {
    const where = {
      ...(filtro === 'PERSONA' ? { OR: [{ modo: 'HUMANO' }, { pideHumano: true }] } : {}),
      ...(filtro === 'NO_LEIDAS' ? { noLeidos: { gt: 0 } } : {}),
      ...(filtro === 'BLOQUEADAS' ? { bloqueado: true } : {}),
      ...(busqueda
        ? { OR: [{ telefono: { contains: busqueda } }, { nombre: { contains: busqueda } }] }
        : {}),
    };
    const conversaciones = await prisma.whatsappConversacion.findMany({
      where,
      orderBy: { ultimoMensajeAt: 'desc' },
      take: limite,
      select: {
        ...RESUMEN,
        mensajes: { orderBy: { createdAt: 'desc' }, take: 1, select: { autor: true, texto: true } },
      },
    });
    return conversaciones.map(({ mensajes, ...resto }) => ({ ...resto, ultimo: mensajes[0] ?? null }));
  },

  /** Los números del día y lo que espera a una persona. */
  async cifras(desde) {
    const [conversaciones, delCliente, delBot, esperando] = await prisma.$transaction([
      prisma.whatsappConversacion.count({ where: { ultimoMensajeAt: { gte: desde } } }),
      prisma.whatsappMensaje.count({ where: { autor: 'CLIENTE', createdAt: { gte: desde } } }),
      prisma.whatsappMensaje.count({ where: { autor: 'BOT', createdAt: { gte: desde } } }),
      prisma.whatsappConversacion.count({
        where: { bloqueado: false, OR: [{ modo: 'HUMANO' }, { pideHumano: true }] },
      }),
    ]);
    return { conversaciones, delCliente, delBot, esperando };
  },

  borrarConversacion(id) {
    return prisma.whatsappConversacion.delete({ where: { id } });
  },

  /** Lo que pasó el plazo de retención. Las conversaciones vacías se van también. */
  async purgar(antesDe) {
    const mensajes = await prisma.whatsappMensaje.deleteMany({ where: { createdAt: { lt: antesDe } } });
    const conversaciones = await prisma.whatsappConversacion.deleteMany({
      where: { ultimoMensajeAt: { lt: antesDe } },
    });
    return { mensajes: mensajes.count, conversaciones: conversaciones.count };
  },
};

module.exports = whatsappRepository;
