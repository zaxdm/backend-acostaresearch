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

  /** De estas claves de venta, las que ya tienen boleta. */
  async clavesConBoleta(claves) {
    if (claves.length === 0) return new Set();
    const filas = await prisma.comprobante.findMany({
      where: { origenClave: { in: claves } },
      select: { origenClave: true },
    });
    return new Set(filas.map((f) => f.origenClave));
  },

  pendientes(limite) {
    return prisma.comprobante.findMany({
      where: { estado: 'PENDIENTE' },
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

  actualizar(id, data) {
    return prisma.comprobante.update({ where: { id }, data });
  },
};

module.exports = sunatRepository;
