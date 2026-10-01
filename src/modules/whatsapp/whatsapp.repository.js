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
  imagenId: true,
  createdAt: true,
};

/** Lo que el panel enseña de cada imagen. El archivo y el id de Meta, no. */
const IMAGEN = {
  id: true,
  nombre: true,
  cuando: true,
  pie: true,
  enBot: true,
  mime: true,
  bytes: true,
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

  /**
   * El equipo le escribió desde el celular: la conversación pasa a una persona
   * y queda leída. Si la empezó el equipo, se crea aquí (sin nombre todavía).
   */
  anotarDelEquipo(telefono, ahora = new Date()) {
    const tomada = { modo: 'HUMANO', pideHumano: false, noLeidos: 0, ultimoMensajeAt: ahora };
    return prisma.whatsappConversacion.upsert({
      where: { telefono },
      create: { telefono, ...tomada },
      update: tomada,
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

  // ── La galería de imágenes ───────────────────────────────────────────────

  imagenes() {
    return prisma.whatsappImagen.findMany({ orderBy: [{ enBot: 'desc' }, { createdAt: 'desc' }], select: IMAGEN });
  },

  /** Las que puede mandar el bot, con lo que necesita para elegirlas. */
  imagenesDelBot() {
    return prisma.whatsappImagen.findMany({
      where: { enBot: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, nombre: true, cuando: true },
    });
  },

  /** Con el archivo y el id de Meta: para mandarla o servirla. */
  imagenCompleta(id) {
    return prisma.whatsappImagen.findUnique({ where: { id } });
  },

  crearImagen(datos) {
    return prisma.whatsappImagen.create({ data: datos, select: IMAGEN });
  },

  actualizarImagen(id, datos) {
    return prisma.whatsappImagen.update({ where: { id }, data: datos, select: IMAGEN });
  },

  /** Anota el id que dio Meta al subirla y hasta cuándo vale. */
  anotarMedia(id, mediaId, mediaHasta) {
    return prisma.whatsappImagen.update({ where: { id }, data: { mediaId, mediaHasta }, select: { id: true } });
  },

  borrarImagen(id) {
    return prisma.whatsappImagen.delete({ where: { id } });
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
