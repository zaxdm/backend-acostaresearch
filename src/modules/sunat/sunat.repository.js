'use strict';

const prisma = require('../../lib/prisma');

/** Las mismas condiciones de venta que `ventas.repository`. */
const PAGO_COBRADO = { status: 'PAID', amountCents: { gt: 0 } };
const CODIGO_VENDIDO = {
  status: { not: 'VOID' },
  paymentMethod: { not: null },
  NOT: { paymentMethod: 'CORTESIA' },
  amountCents: { gt: 0 },
};

const sunatRepository = {
  pagosCobrados(desde, hasta) {
    return prisma.payment.findMany({
      where: { ...PAGO_COBRADO, paidAt: { gte: desde, lt: hasta } },
      select: {
        id: true,
        cartId: true,
        providerOrderId: true,
        amountCents: true,
        currency: true,
        paidAt: true,
        plan: { select: { name: true, code: true, productCode: true } },
        user: { select: { firstName: true, lastName: true, pais: true } },
      },
      orderBy: { paidAt: 'asc' },
    });
  },

  codigosVendidos(desde, hasta) {
    return prisma.activationCode.findMany({
      where: { ...CODIGO_VENDIDO, createdAt: { gte: desde, lt: hasta } },
      // El producto de la licencia, si se canjeó: un código vendido como Método y
      // movido después al Humanizador se factura como Humanizador.
      select: {
        id: true,
        productCode: true,
        amountCents: true,
        createdAt: true,
        license: { select: { productCode: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Servicios registrados en el panel y cobrados entre esas fechas (los anulados no). */
  serviciosCobrados(desde, hasta) {
    return prisma.servicioRegistrado.findMany({
      where: { estado: 'VIGENTE', pagadoEn: { gte: desde, lt: hasta } },
      orderBy: { pagadoEn: 'asc' },
    });
  },

  crearServicio(data) {
    return prisma.servicioRegistrado.create({ data });
  },

  buscarServicio(id) {
    return prisma.servicioRegistrado.findUnique({ where: { id } });
  },

  /** Los registrados entre dos fechas, del más reciente al más antiguo. */
  serviciosRegistrados(desde, hasta) {
    return prisma.servicioRegistrado.findMany({
      where: { creadoEn: { gte: desde, lt: hasta } },
      orderBy: { creadoEn: 'desc' },
    });
  },

  marcarServicio(id, estado) {
    return prisma.servicioRegistrado.update({ where: { id }, data: { estado } });
  },

  borrarServicio(id) {
    return prisma.servicioRegistrado.delete({ where: { id } });
  },

  /** De estas claves de venta, las que ya tienen boleta. */
  async clavesConBoleta(claves) {
    if (claves.length === 0) return new Set();
    const filas = await prisma.comprobante.findMany({
      where: { origenClave: { in: claves } },
      select: { origenClave: true },
    });
    return new Set(filas.map((f) => f.origenClave));
  },

  /**
   * Las que siguen sin respuesta de SUNAT. Las de menos de un minuto no: puede
   * estar enviándolas ahora mismo otro proceso (el script de anular).
   */
  pendientes(limite) {
    return prisma.comprobante.findMany({
      where: { estado: 'PENDIENTE', creadoEn: { lt: new Date(Date.now() - 60 * 1000) } },
      orderBy: { creadoEn: 'asc' },
      take: limite,
    });
  },

  /**
   * Reserva el número siguiente de la serie y guarda la boleta, en la misma
   * transacción. `armar(numero)` devuelve los datos de la fila ya firmada. Si
   * la venta ya tenía boleta (`origenClave` repetida), nada se guarda y el
   * número no se gasta.
   */
  crearConNumero(serie, armar) {
    return prisma.$transaction(async (tx) => {
      await tx.serieComprobante.createMany({ data: [{ serie, ultimo: 0 }], skipDuplicates: true });
      // UPDATE … SET ultimo = ultimo + 1: bloquea la fila hasta el final.
      const { ultimo } = await tx.serieComprobante.update({
        where: { serie },
        data: { ultimo: { increment: 1 } },
      });
      return tx.comprobante.create({ data: armar(ultimo) });
    });
  },

  buscar(serie, numero) {
    return prisma.comprobante.findUnique({ where: { serie_numero: { serie, numero } } });
  },

  /** Si la venta de esta clave sigue contando como venta (y se volvería a facturar). */
  async sigueSiendoVenta(origenClave) {
    const [tipo, id] = origenClave.split(':');
    if (tipo === 'PAGO') return (await prisma.payment.count({ where: { id, ...PAGO_COBRADO } })) > 0;
    if (tipo === 'CARRITO') return (await prisma.payment.count({ where: { cartId: id, ...PAGO_COBRADO } })) > 0;
    if (tipo === 'CODIGO') return (await prisma.activationCode.count({ where: { id, ...CODIGO_VENDIDO } })) > 0;
    if (tipo === 'SERVICIO') return (await prisma.servicioRegistrado.count({ where: { id, estado: 'VIGENTE' } })) > 0;
    return false;
  },

  /**
   * Marca la boleta como anulada soltando su clave de venta: `CODIGO:x` pasa a
   * `CODIGO:x|ANULADA:BC01-1`. Así la venta vuelve a quedar sin boleta.
   */
  async liberarVenta(serie, numero, nota) {
    const boleta = await prisma.comprobante.findUnique({ where: { serie_numero: { serie, numero } } });
    if (!boleta || boleta.origenClave.includes('|ANULADA')) return;
    await prisma.comprobante.update({
      where: { id: boleta.id },
      data: { origenClave: `${boleta.origenClave}|ANULADA:${nota}` },
    });
  },

  /** Aceptadas cuyo correo al cliente aún no se resolvió, en orden de emisión. */
  correosPendientes(limite) {
    return prisma.comprobante.findMany({
      where: { estado: { in: ['ACEPTADO', 'OBSERVADO'] }, correo: null },
      orderBy: { creadoEn: 'asc' },
      take: limite,
    });
  },

  /**
   * A quién se le manda la boleta de esta venta: quien pagó; en un código, quien
   * lo canjeó o, si aún no, el correo del comprador. Null si no hay correo.
   */
  async destinatario(origenClave) {
    const [tipo, id] = origenClave.split('|')[0].split(':');
    const usuario = { select: { email: true, firstName: true } };
    if (tipo === 'PAGO' || tipo === 'CARRITO') {
      const pago = await prisma.payment.findFirst({
        where: tipo === 'PAGO' ? { id } : { cartId: id },
        select: { payerEmail: true, user: usuario },
      });
      const email = pago?.user?.email ?? pago?.payerEmail;
      return email ? { email, nombre: pago?.user?.firstName ?? null } : null;
    }
    if (tipo === 'CODIGO') {
      const codigo = await prisma.activationCode.findUnique({
        where: { id },
        select: { buyerEmail: true, license: { select: { user: usuario } } },
      });
      const email = codigo?.license?.user?.email ?? codigo?.buyerEmail;
      return email ? { email, nombre: codigo?.license?.user?.firstName ?? null } : null;
    }
    if (tipo === 'SERVICIO') {
      const servicio = await prisma.servicioRegistrado.findUnique({
        where: { id },
        select: { clienteEmail: true, clienteNombre: true },
      });
      if (!servicio?.clienteEmail) return null;
      return { email: servicio.clienteEmail, nombre: servicio.clienteNombre.split(' ')[0] || null };
    }
    return null;
  },

  /**
   * Las claves de facturación de una venta del panel de Accesos. El pago que
   * nació de canjear un código se factura por su código.
   */
  async clavesDeVenta(canal, id) {
    if (canal === 'codigo') return [`CODIGO:${id}`];
    const pago = await prisma.payment.findUnique({ where: { id }, select: { cartId: true, providerOrderId: true } });
    if (!pago) return [];
    const delCanje = await prisma.activationCode.findUnique({ where: { id: pago.providerOrderId }, select: { id: true } });
    if (delCanje) return [`CODIGO:${delCanje.id}`];
    return [`PAGO:${id}`, pago.cartId ? `CARRITO:${pago.cartId}` : null].filter(Boolean);
  },

  /**
   * Las boletas de esas claves (vigentes y anuladas) y las notas que las
   * anulan, de la más antigua a la más reciente. Sin el XML ni la CDR.
   */
  async deClaves(claves) {
    if (claves.length === 0) return [];
    const select = {
      id: true,
      tipo: true,
      serie: true,
      numero: true,
      origenClave: true,
      fechaEmision: true,
      clienteNombre: true,
      clienteTipoDoc: true,
      clienteNumDoc: true,
      moneda: true,
      totalCents: true,
      valorCents: true,
      igvCents: true,
      monedaOriginal: true,
      importeOriginalCents: true,
      items: true,
      estado: true,
      codigoSunat: true,
      mensaje: true,
      intentos: true,
      enviadoEn: true,
      correo: true,
      correoEnviadoEn: true,
      cdrZip: false,
    };
    const boletas = await prisma.comprobante.findMany({
      where: { tipo: '03', OR: claves.map((c) => ({ origenClave: { startsWith: c } })) },
      select,
      orderBy: { creadoEn: 'asc' },
    });
    // `startsWith` también casaría `PAGO:abc` con `PAGO:abcd`: se filtra exacto.
    const suyas = boletas.filter((b) => claves.includes(b.origenClave.split('|')[0]));
    const notas = suyas.length
      ? await prisma.comprobante.findMany({
          where: { tipo: '07', origenClave: { in: suyas.map((b) => `ANULA:${b.serie}-${b.numero}`) } },
          select,
          orderBy: { creadoEn: 'asc' },
        })
      : [];
    return [...suyas, ...notas].sort((a, b) => a.fechaEmision - b.fechaEmision);
  },

  buscarPorId(id) {
    return prisma.comprobante.findUnique({ where: { id } });
  },

  /** La lista del panel, sin el XML ni la CDR, que pesan. */
  listar({ limite = 200 } = {}) {
    return prisma.comprobante.findMany({
      orderBy: { creadoEn: 'desc' },
      take: limite,
      select: {
        id: true,
        tipo: true,
        serie: true,
        numero: true,
        origenClave: true,
        fechaEmision: true,
        clienteNombre: true,
        clienteTipoDoc: true,
        totalCents: true,
        monedaOriginal: true,
        importeOriginalCents: true,
        items: true,
        estado: true,
        codigoSunat: true,
        mensaje: true,
        intentos: true,
        correo: true,
        correoEnviadoEn: true,
      },
    });
  },

  /** El usuario dueño de la venta de esta clave (quien pagó o canjeó), o null. */
  async duenoDe(origenClave) {
    const [tipo, id] = origenClave.split('|')[0].split(':');
    if (tipo === 'PAGO' || tipo === 'CARRITO') {
      const pago = await prisma.payment.findFirst({
        where: tipo === 'PAGO' ? { id } : { cartId: id },
        select: { userId: true },
      });
      return pago?.userId ?? null;
    }
    if (tipo === 'CODIGO') {
      const codigo = await prisma.activationCode.findUnique({
        where: { id },
        select: { license: { select: { userId: true } } },
      });
      return codigo?.license?.userId ?? null;
    }
    return null;
  },

  /**
   * Las boletas vigentes de los pagos de un usuario, por id de pago. Un pago se
   * factura por su id, por su carrito o, si nació de canjear un código, por el
   * código (su número de orden es el id del código). Una boleta anulada ya no
   * coincide: su clave lleva `|ANULADA:…`.
   */
  async boletasDeUsuario(userId) {
    const pagos = await prisma.payment.findMany({
      where: { userId, status: 'PAID' },
      select: { id: true, cartId: true, providerOrderId: true },
    });
    const clavesDe = (p) =>
      [`PAGO:${p.id}`, p.cartId && `CARRITO:${p.cartId}`, `CODIGO:${p.providerOrderId}`].filter(Boolean);
    const todas = [...new Set(pagos.flatMap(clavesDe))];
    if (todas.length === 0) return [];
    const boletas = await prisma.comprobante.findMany({
      where: { tipo: '03', origenClave: { in: todas }, estado: { in: ['ACEPTADO', 'OBSERVADO'] } },
      select: { id: true, serie: true, numero: true, origenClave: true },
    });
    const porClave = new Map(boletas.map((b) => [b.origenClave, b]));
    return pagos.flatMap((p) => {
      const boleta = clavesDe(p).map((c) => porClave.get(c)).find(Boolean);
      return boleta ? [{ paymentId: p.id, id: boleta.id, numero: `${boleta.serie}-${boleta.numero}` }] : [];
    });
  },

  actualizar(id, data) {
    return prisma.comprobante.update({ where: { id }, data });
  },
};

module.exports = sunatRepository;
