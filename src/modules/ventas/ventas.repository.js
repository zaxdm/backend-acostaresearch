'use strict';

const prisma = require('../../lib/prisma');

/** Una venta por código: no anulado, cobrado (no cortesía) y con importe. */
const CODIGO_VENDIDO = {
  status: { not: 'VOID' },
  paymentMethod: { not: null },
  NOT: { paymentMethod: 'CORTESIA' },
  amountCents: { gt: 0 },
};

const PAGO_COBRADO = { status: 'PAID', amountCents: { gt: 0 } };

/** Resumen de un cierre, sin el PDF ni el detalle, que pesan. */
const resumenDeCierre = {
  id: true,
  anio: true,
  mes: true,
  ventas: true,
  totalSolesCents: true,
  totalesPorMoneda: true,
  creadoEn: true,
};

const ventasRepository = {
  pagosCobrados(desde, hasta) {
    return prisma.payment.findMany({
      where: { ...PAGO_COBRADO, paidAt: { gte: desde, lt: hasta } },
      select: {
        id: true,
        provider: true,
        providerOrderId: true,
        providerCaptureId: true,
        operationCode: true,
        amountCents: true,
        currency: true,
        discountCents: true,
        paidAt: true,
        payerEmail: true,
        plan: { select: { name: true } },
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });
  },

  codigosVendidos(desde, hasta) {
    return prisma.activationCode.findMany({
      where: { ...CODIGO_VENDIDO, createdAt: { gte: desde, lt: hasta } },
      select: {
        id: true,
        hint: true,
        productCode: true,
        buyerEmail: true,
        paymentMethod: true,
        paymentRef: true,
        amountCents: true,
        createdAt: true,
      },
    });
  },

  /** De estos ids, los que son códigos: sus pagos son canjes y no cuentan. */
  async codigosEntre(ids) {
    if (ids.length === 0) return new Set();
    const filas = await prisma.activationCode.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(filas.map((fila) => fila.id));
  },

  /** Nombre comercial de cada producto, sacado de su plan. */
  async nombresDeProducto(productCodes) {
    if (productCodes.length === 0) return {};
    const planes = await prisma.plan.findMany({
      where: { productCode: { in: productCodes } },
      select: { productCode: true, name: true, active: true },
      orderBy: { sortOrder: 'asc' },
    });
    const nombres = {};
    // El activo gana: un plan retirado puede conservar un nombre viejo.
    for (const plan of [...planes].sort((a, b) => Number(b.active) - Number(a.active))) {
      nombres[plan.productCode] ??= plan.name;
    }
    return nombres;
  },

  /** Fecha de la venta más antigua, o null si todavía no hay ninguna. */
  async primeraVenta() {
    const [pago, codigo] = await Promise.all([
      prisma.payment.aggregate({ where: PAGO_COBRADO, _min: { paidAt: true } }),
      prisma.activationCode.aggregate({ where: CODIGO_VENDIDO, _min: { createdAt: true } }),
    ]);
    const fechas = [pago._min.paidAt, codigo._min.createdAt].filter(Boolean);
    return fechas.length ? new Date(Math.min(...fechas.map((f) => f.getTime()))) : null;
  },

  listarCierres() {
    return prisma.cierreMensual.findMany({
      select: resumenDeCierre,
      orderBy: [{ anio: 'desc' }, { mes: 'desc' }],
    });
  },

  buscarCierre(anio, mes) {
    return prisma.cierreMensual.findUnique({ where: { anio_mes: { anio, mes } } });
  },

  crearCierre(datos) {
    return prisma.cierreMensual.create({ data: datos, select: resumenDeCierre });
  },
};

module.exports = ventasRepository;
