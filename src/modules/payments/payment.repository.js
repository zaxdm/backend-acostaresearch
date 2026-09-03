'use strict';

const prisma = require('../../lib/prisma');

const paymentSelect = {
  id: true,
  provider: true,
  providerOrderId: true,
  status: true,
  amountCents: true,
  currency: true,
  createdAt: true,
  paidAt: true,
  plan: { select: { code: true, name: true, words: true, durationDays: true } },
};

const paymentRepository = {
  paymentSelect,

  create(data) {
    return prisma.payment.create({ data });
  },

  /** El pago con su plan completo: hace falta para crear la bolsa. */
  findByOrderId(provider, providerOrderId) {
    return prisma.payment.findUnique({
      where: { provider_providerOrderId: { provider, providerOrderId } },
      include: { plan: true },
    });
  },

  findForUser(id, userId) {
    return prisma.payment.findFirst({ where: { id, userId }, select: paymentSelect });
  },

  listForUser(userId, { limit = 20 } = {}) {
    return prisma.payment.findMany({
      where: { userId },
      select: paymentSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * Cierra el cobro: marca el pago como pagado y entrega la bolsa, todo en la
   * misma transacción.
   *
   * El `updateMany` con `status: 'PENDING'` es la pieza clave: hace de cerrojo.
   * Si dos peticiones intentan confirmar el mismo pago a la vez —doble clic,
   * reintento del navegador— solo una encuentra el pago pendiente; la otra ve
   * cero filas afectadas y recibe `null`, así que nunca se entregan dos bolsas
   * por un mismo cobro.
   */
  settle({ paymentId, captura, entregar }) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: {
          status: 'PAID',
          providerCaptureId: captura.captureId,
          payerEmail: captura.payerEmail,
          rawResponse: JSON.stringify(captura.raw ?? null),
          paidAt: new Date(),
        },
      });

      if (count === 0) return null;

      // Qué se entrega depende del plan: una bolsa de palabras o una licencia.
      // La entrega va dentro de la misma transacción que el cobro, de modo que
      // no puede quedar un pago cobrado sin nada entregado.
      const { enlace, resultado } = await entregar(tx);
      await tx.payment.update({ where: { id: paymentId }, data: enlace });

      return resultado;
    });
  },

  /** Deja constancia del rechazo. No toca un pago ya cobrado. */
  async fail(paymentId, { errorCode, rawResponse }) {
    await prisma.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        errorCode,
        rawResponse: rawResponse ? JSON.stringify(rawResponse) : undefined,
      },
    });
  },

  async cancel(paymentId, userId) {
    const { count } = await prisma.payment.updateMany({
      where: { id: paymentId, userId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    return count > 0;
  },

  /** Bolsa ya entregada por este pago, para responder igual en un reintento. */
  findPack(wordPackId) {
    return prisma.wordPack.findUnique({
      where: { id: wordPackId },
      select: {
        id: true,
        wordsTotal: true,
        wordsUsed: true,
        status: true,
        activatedAt: true,
        expiresAt: true,
        plan: { select: { code: true, name: true } },
      },
    });
  },

  listRecent({ limit = 50 } = {}) {
    return prisma.payment.findMany({
      select: {
        ...paymentSelect,
        providerCaptureId: true,
        payerEmail: true,
        errorCode: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};

module.exports = paymentRepository;
