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
  reviewNote: true,
  // Las compras con carrito comparten este identificador; null en las sueltas.
  cartId: true,
  // `productCode` además de `code`: son cosas distintas y el panel necesita la
  // primera. Varios planes pueden vender el mismo producto —uno suelto y otro
  // en oferta—, y lo que decide qué capítulos ve el comprador es el producto.
  plan: {
    select: { code: true, productCode: true, name: true, words: true, durationDays: true },
  },
};

/**
 * Los pagos de un país: los de sus clientes y los que se pagaron con uno de sus
 * descuentos (un cliente no lleva la etiqueta hasta que su primer pago se
 * confirma, y mientras espera revisión también tiene que salir).
 *
 * `undefined` = todos; `null` = los de la casa, que son justo el resto.
 */
function delPais(pais) {
  if (pais === undefined) return {};
  if (pais === null) {
    return {
      user: { pais: null },
      billeteraId: null,
      OR: [{ discountCodeId: null }, { discountCode: { pais: null } }],
    };
  }
  return { OR: [{ user: { pais } }, { discountCode: { pais } }, { billetera: { pais } }] };
}

/**
 * La bandeja de comprobantes de un país.
 *
 * Aquí el país no es el del cliente sino el del medio por el que pagó: cada
 * país revisa lo que entra en SU billetera. Sin país es la bandeja de la casa
 * —Yape y Western Union—, que es la de siempre.
 */
function deLaBandeja(pais) {
  return pais ? { billetera: { pais } } : { billeteraId: null };
}

const COMPRADOR = { id: true, email: true, firstName: true, lastName: true, pais: true };
/** De la billetera, lo que el panel enseña junto al pago. */
const BILLETERA = { id: true, nombre: true, pais: true };

const paymentRepository = {
  paymentSelect,
  delPais,
  deLaBandeja,

  create(data) {
    return prisma.payment.create({ data });
  },

  /**
   * Las filas de un carrito, todas o ninguna: un carrito a medio guardar
   * cobraría la suma entera y entregaría solo una parte.
   */
  createCart(filas) {
    return prisma.$transaction(filas.map((data) => prisma.payment.create({ data })));
  },

  /** El pago de un cobro ya hecho, por el identificador que da la pasarela. */
  findByCaptureId(provider, providerCaptureId) {
    return prisma.payment.findFirst({
      where: { provider, providerCaptureId },
      include: {
        plan: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
  },

  /**
   * Anota en un pago cobrado que la pasarela devolvió el dinero (reembolso o
   * contracargo). No cambia el estado: el acceso lo quita `hotmart.webhook`.
   */
  marcarDevolucion(id, { errorCode, rawResponse }) {
    return prisma.payment.update({
      where: { id },
      data: { errorCode, rawResponse: JSON.stringify(rawResponse ?? null) },
    });
  },

  /** Las filas de un carrito, con lo mismo que trae `findByOrderId`. */
  findCart(cartId) {
    return prisma.payment.findMany({
      where: { cartId },
      include: {
        plan: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
  },

  /**
   * El pago con su plan completo: hace falta para crear la bolsa.
   *
   * Y con el comprador, que es a quien hay que escribirle al entregar. Va aquí
   * y no en una consulta aparte porque `payment.delivery` avisa por correo en
   * las dos vías de cobro, y la de Yape ya traía al usuario cargado: sin esto,
   * el que paga con pasarela se quedaría sin su correo de entrega.
   */
  findByOrderId(provider, providerOrderId) {
    return prisma.payment.findUnique({
      where: { provider_providerOrderId: { provider, providerOrderId } },
      include: {
        plan: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
  },

  /**
   * Todo lo que lleva la constancia de pago: el plan, el comprador y el código
   * de descuento, si lo hubo. No filtra por dueño: eso lo decide el servicio,
   * porque un administrador también puede descargarla.
   */
  findForConstancia(id) {
    return prisma.payment.findUnique({
      where: { id },
      include: {
        plan: { select: { code: true, name: true, kind: true, words: true, durationDays: true } },
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        discountCode: { select: { code: true } },
      },
    });
  },

  findForUser(id, userId) {
    return prisma.payment.findFirst({ where: { id, userId }, select: paymentSelect });
  },

  /**
   * «Mis compras». Cada clic en el botón de PayPal o Culqi abre una orden
   * PENDING aunque luego no se pague, y el comprador las veía como compras
   * «Pendiente» repetidas; además le empujaban las reales fuera del límite.
   * Las órdenes de pasarela abiertas o canceladas no son compras: no se listan.
   * Los Yape pendientes sí, porque ahí falta el comprobante del comprador.
   */
  listForUser(userId, { limit = 20 } = {}) {
    return prisma.payment.findMany({
      where: {
        userId,
        NOT: { provider: { in: ['PAYPAL', 'CULQI'] }, status: { in: ['PENDING', 'CANCELLED'] } },
      },
      select: paymentSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * Cierra el cobro: marca el pago como pagado y entrega la bolsa, todo en la
   * misma transacción.
   *
   * El `updateMany` con el estado de partida es la pieza clave: hace de cerrojo.
   * Si dos peticiones intentan confirmar el mismo pago a la vez —doble clic,
   * reintento del navegador, dos administradores aprobando— solo una lo
   * encuentra en ese estado; la otra ve cero filas afectadas y recibe `null`,
   * así que nunca se entregan dos bolsas por un mismo cobro.
   */
  settle({ paymentId, captura, entregar, estadoEsperado = 'PENDING' }) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, status: estadoEsperado },
        data: {
          status: 'PAID',
          providerCaptureId: captura.captureId,
          payerEmail: captura.payerEmail,
          rawResponse: JSON.stringify(captura.raw ?? null),
          paidAt: new Date(),
          // Hotmart cobra su propio precio fijo, que puede no ser el del plan:
          // la fila se queda con lo que de verdad se cobró.
          ...(captura.importeReal ?? {}),
        },
      });

      if (count === 0) return null;

      // Qué se entrega depende del plan: una bolsa de palabras, una licencia
      // del conector o una membresía de «Preparar documento».
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

  /**
   * Un intento rechazado que NO cierra el pago (tarjeta denegada en Culqi): el
   * comprador puede reintentar con otra. Se guarda el último motivo para que
   * el panel lo enseñe, sin cambiar el estado.
   */
  async noteAttempt(paymentId, { errorCode, rawResponse }) {
    await prisma.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data: {
        errorCode: String(errorCode).slice(0, 60),
        rawResponse: rawResponse ? JSON.stringify(rawResponse) : undefined,
      },
    });
  },

  /** `motivo`: por qué se cerró (el error del botón de PayPal), para el panel. */
  async cancel(paymentId, userId, motivo = null) {
    const { count } = await prisma.payment.updateMany({
      where: { id: paymentId, userId, status: 'PENDING' },
      data: { status: 'CANCELLED', ...(motivo ? { errorCode: String(motivo).slice(0, 60) } : {}) },
    });
    return count > 0;
  },

  /** Cierra todas las filas abiertas de un carrito: se abandonó entero. */
  async cancelCart(cartId, userId, motivo = null) {
    const { count } = await prisma.payment.updateMany({
      where: { cartId, userId, status: 'PENDING' },
      data: { status: 'CANCELLED', ...(motivo ? { errorCode: String(motivo).slice(0, 60) } : {}) },
    });
    return count > 0;
  },

  /**
   * Las otras órdenes abiertas del mismo comprador en la misma pasarela: al
   * abrir una nueva, las anteriores ya no las va a terminar (doble clic, o
   * volvió a pulsar el botón después de cerrar la ventana).
   *
   * `exceptCartId` deja en paz las demás filas del carrito recién abierto. Va
   * con OR y no con NOT: en SQL, «no es este carrito» descarta también las
   * filas sin carrito, que son justo las que hay que cerrar.
   */
  async cancelOtherOpen({ userId, provider, exceptId, exceptCartId = null }) {
    const { count } = await prisma.payment.updateMany({
      where: {
        userId,
        provider,
        status: 'PENDING',
        id: { not: exceptId },
        ...(exceptCartId ? { OR: [{ cartId: null }, { cartId: { not: exceptCartId } }] } : {}),
      },
      data: { status: 'CANCELLED' },
    });
    return count;
  },

  /**
   * Cierra las órdenes de pasarela que nadie terminó antes de `antesDe`. Solo
   * PayPal y Culqi: un Yape pendiente es un comprobante esperando revisión y
   * no caduca. El motivo que ya tuvieran (tarjeta rechazada) se respeta.
   */
  async cancelAbandoned({ antesDe }) {
    const where = {
      provider: { in: ['PAYPAL', 'CULQI'] },
      status: 'PENDING',
      createdAt: { lt: antesDe },
    };
    const sinMotivo = await prisma.payment.updateMany({
      where: { ...where, errorCode: null },
      data: { status: 'CANCELLED', errorCode: 'ABANDONADA' },
    });
    const conMotivo = await prisma.payment.updateMany({ where, data: { status: 'CANCELLED' } });
    return sinMotivo.count + conMotivo.count;
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

  // ── Pago manual (Yape) ───────────────────────────────────────────────────

  /** El pago con su plan completo. Hace falta para entregar lo comprado. */
  findByIdWithPlan(id) {
    return prisma.payment.findUnique({ where: { id }, include: { plan: true } });
  },

  /**
   * Comprobantes esperando revisión, del más antiguo al más nuevo.
   *
   * El orden no es el habitual a propósito: aquí hay gente esperando su
   * acceso, y el que lleva más tiempo esperando es el que hay que mirar antes.
   */
  listInReview({ limit = 100, pais } = {}) {
    return prisma.payment.findMany({
      where: { status: 'IN_REVIEW', ...deLaBandeja(pais) },
      select: {
        ...paymentSelect,
        billetera: { select: BILLETERA },
        operationCode: true,
        proofMime: true,
        proofCheck: true,
        discountCents: true,
        user: { select: COMPRADOR },
      },
      orderBy: [{ createdAt: 'asc' }, { providerOrderId: 'asc' }],
      take: limit,
    });
  },

  /**
   * Engancha la captura al pago y lo pone a la espera de revisión.
   *
   * Solo avanza desde PENDING o IN_REVIEW: un pago ya aprobado no admite otra
   * captura, que sería la forma evidente de colar un comprobante distinto del
   * que se aprobó.
   */
  /** Apunta el veredicto de la revisión automática de la captura. */
  saveProofCheck(ids, revision) {
    return prisma.payment.updateMany({
      where: { id: { in: ids } },
      data: { proofCheck: JSON.stringify(revision).slice(0, 255) },
    });
  },

  async attachProof(id, { userId, proofPath, proofMime, operationCode }) {
    const { count } = await prisma.payment.updateMany({
      where: { id, userId, status: { in: ['PENDING', 'IN_REVIEW'] } },
      data: {
        proofPath,
        proofMime,
        ...(operationCode === undefined ? {} : { operationCode }),
        status: 'IN_REVIEW',
      },
    });
    return count > 0;
  },

  /**
   * Los comprobantes de este comprador que siguen esperando revisión por alguno
   * de estos planes. Con uno basta: el segundo solo llena la bandeja.
   */
  findInReviewForPlans(userId, planIds) {
    return prisma.payment.findMany({
      where: { userId, planId: { in: planIds }, status: 'IN_REVIEW' },
      select: { id: true, plan: { select: { name: true } } },
    });
  },

  /**
   * Si ese número de operación ya está en otro pago en revisión o pagado. Uno
   * rechazado o cancelado no cuenta: el mismo pago puede volver con otra captura.
   */
  async operationCodeInUse({ provider, operationCode }) {
    const fila = await prisma.payment.findFirst({
      where: { provider, operationCode, status: { in: ['IN_REVIEW', 'PAID'] } },
      select: { id: true },
    });
    return Boolean(fila);
  },

  /** Cuántos comprobantes le rechazamos desde `desde` (un carrito cuenta uno). */
  async countRecentRejections({ userId, providers, desde }) {
    const filas = await prisma.payment.findMany({
      where: { userId, provider: { in: providers }, status: 'REJECTED', reviewedAt: { gte: desde } },
      select: { id: true, cartId: true },
    });
    return new Set(filas.map((fila) => fila.cartId ?? fila.id)).size;
  },

  /** El comprador retira su comprobante antes de que lo revisen. */
  async cancelInReview(ids, userId) {
    const { count } = await prisma.payment.updateMany({
      where: { id: { in: ids }, userId, status: 'IN_REVIEW' },
      data: { status: 'CANCELLED', errorCode: 'CANCELADO_POR_COMPRADOR' },
    });
    return count;
  },

  /** Deja el pago rechazado con el motivo que verá el comprador. */
  async reject(id, { reviewedById, reviewNote }) {
    const { count } = await prisma.payment.updateMany({
      where: { id, status: 'IN_REVIEW' },
      data: { status: 'REJECTED', reviewedById, reviewedAt: new Date(), reviewNote },
    });
    return count > 0;
  },

  /** Anota quién aprobó, una vez la entrega ya se cerró en su transacción. */
  markReviewed(id, reviewedById) {
    return prisma.payment.update({
      where: { id },
      data: { reviewedById, reviewedAt: new Date() },
    });
  },

  /**
   * Comprobantes manuales ya resueltos, del más reciente al más antiguo.
   *
   * Es el historial del panel: lo que queda cuando un pago sale de la bandeja.
   * Entran también los que nunca llegaron a comprobante —PENDING sin captura,
   * CANCELLED— porque un pago de Yape que se quedó a medias es justo lo que se
   * busca cuando alguien escribe «pagué y no me llegó nada».
   */
  listReviewed({ provider, limit = 200, pais } = {}) {
    return prisma.payment.findMany({
      // Uno o varios: el historial junta Yape y Western Union.
      where: {
        provider: Array.isArray(provider) ? { in: provider } : provider,
        status: { not: 'IN_REVIEW' },
        ...deLaBandeja(pais),
      },
      select: {
        ...paymentSelect,
        billetera: { select: BILLETERA },
        // La licencia que entregó este cobro y qué producto tiene HOY.
        //
        // No es lo mismo que `plan`: el plan es lo que se compró y se queda
        // como está —reescribirlo falsearía la venta y el gráfico de ingresos—,
        // mientras que la licencia se puede mover de producto después.
        licenseId: true,
        license: { select: { productCode: true } },
        operationCode: true,
        discountCents: true,
        proofPath: true,
        reviewedAt: true,
        user: { select: COMPRADOR },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * Cuántos comprobantes esperan. Un carrito es UN comprobante aunque sean
   * varias filas: es una sola captura y se aprueba de una vez.
   */
  async countInReview() {
    const filas = await prisma.payment.findMany({
      where: { status: 'IN_REVIEW' },
      select: { cartId: true },
    });
    const carritos = new Set(filas.filter((f) => f.cartId).map((f) => f.cartId));
    return filas.filter((f) => !f.cartId).length + carritos.size;
  },

  /** Cuántos pagos usan esta captura. Las de un carrito la comparten. */
  countByProofPath(proofPath) {
    return prisma.payment.count({ where: { proofPath } });
  },

  /**
   * Todos los pagos, del más reciente al más antiguo. Antes eran los últimos
   * 50 y los gráficos de ingresos del panel se quedaban cortos.
   */
  listRecent({ limit, pais, sinYape = false } = {}) {
    return prisma.payment.findMany({
      // Los Yape solo los ve la casa: al administrador de país no le salen.
      where: { ...delPais(pais), ...(sinYape && { provider: { not: 'YAPE' } }) },
      select: {
        ...paymentSelect,
        licenseId: true,
        license: { select: { productCode: true } },
        providerCaptureId: true,
        payerEmail: true,
        errorCode: true,
        billetera: { select: BILLETERA },
        user: { select: COMPRADOR },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /** Lo justo para decidir si se puede borrar y qué hay que limpiar detrás. */
  findForRemoval(id) {
    return prisma.payment.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        provider: true,
        amountCents: true,
        currency: true,
        licenseId: true,
        wordPackId: true,
        docPackId: true,
        proofPath: true,
        payerEmail: true,
        user: { select: { email: true } },
      },
    });
  },

  remove(id) {
    return prisma.payment.delete({ where: { id } });
  },
};

module.exports = paymentRepository;
