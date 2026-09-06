'use strict';

const prisma = require('../../lib/prisma');

const codeSelect = {
  id: true,
  hint: true,
  productCode: true,
  status: true,
  buyerEmail: true,
  note: true,
  // El cobro apuntado: la tabla del panel lo enseña para que se vea el dinero
  // que sigue en el aire mientras el código no se canjea.
  paymentMethod: true,
  paymentRef: true,
  amountCents: true,
  // Solo si hay comprobante guardado: la tabla enseña el enlace para verlo.
  proofMime: true,
  redeemedAt: true,
  expiresAt: true,
  createdAt: true,
};

const licenseSelect = {
  id: true,
  productCode: true,
  tokenHint: true,
  status: true,
  callsTotal: true,
  lastUsedAt: true,
  callsPerDay: true,
  callsPerMonth: true,
  costCentsPerMonth: true,
  callsLimitTotal: true,
  costCentsLimitTotal: true,
  delivery: true,
  revokedAt: true,
  revokedReason: true,
  expiresAt: true,
  createdAt: true,
};

const licenseRepository = {
  codeSelect,
  licenseSelect,

  // ── Códigos de activación ────────────────────────────────────────────────

  createCodes(filas) {
    return prisma.activationCode.createMany({ data: filas });
  },

  findCodeByHash(codeHash) {
    return prisma.activationCode.findUnique({ where: { codeHash } });
  },

  listCodes({ productCode, status, limit = 100 } = {}) {
    return prisma.activationCode.findMany({
      where: { ...(productCode && { productCode }), ...(status && { status }) },
      select: { ...codeSelect, license: { select: { id: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  voidCode(id) {
    return prisma.activationCode.updateMany({
      where: { id, status: 'AVAILABLE' },
      data: { status: 'VOID' },
    });
  },

  // ── Licencias ────────────────────────────────────────────────────────────

  /**
   * Canjea el código y crea la licencia en una sola transacción.
   *
   * El `updateMany` con `status: 'AVAILABLE'` es el cerrojo: si dos peticiones
   * canjean el mismo código a la vez, solo una lo encuentra disponible. La otra
   * ve cero filas y se va sin licencia, que es justo lo que debe pasar con un
   * código de un solo uso.
   *
   * Si el código traía un cobro apuntado —una venta que se pagó por Western
   * Union, por transferencia o por un Yape que llegó al WhatsApp—, el pago se
   * crea aquí dentro, atado a la licencia. Va en la misma transacción por lo
   * mismo que en `payment.repository.settle`: entregar el acceso y apuntar el
   * dinero son una sola cosa, y partirlas deja el agujero de una venta
   * entregada que no existe en las cuentas.
   */
  redeem({ codeId, datosLicencia, pago = null }) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.activationCode.updateMany({
        where: { id: codeId, status: 'AVAILABLE' },
        data: {
          status: 'REDEEMED',
          redeemedById: datosLicencia.userId,
          redeemedAt: new Date(),
        },
      });

      if (count === 0) return null;

      // Se propagan tal cual los topes que vienen del plan; añadir uno nuevo no
      // obliga a tocar esta función.
      const license = await tx.license.create({
        data: { ...datosLicencia, activationCodeId: codeId },
        select: licenseSelect,
      });

      if (pago) await tx.payment.create({ data: { ...pago, licenseId: license.id } });

      return license;
    });
  },

  /**
   * Licencia sin código de activación de por medio: la compra por la web ya
   * identifica al comprador, así que no tiene sentido darle un código para que
   * se lo canjee a sí mismo.
   */
  create(data, cliente = prisma) {
    return cliente.license.create({ data, select: licenseSelect });
  },

  /**
   * Alarga la vigencia de una licencia que ya existe.
   *
   * Es lo que ocurre al renovar. Se conserva el token —y por tanto la URL que
   * el comprador ya tiene pegada en Claude— porque cambiarlo le obligaría a
   * reinstalar el conector cada trimestre, que es la forma más rápida de que
   * alguien no renueve.
   *
   * Los topes se refrescan con los del plan vigente: quien paga otra vez
   * compra el producto de hoy, no el de hace tres meses.
   *
   * No resucita una licencia revocada: `revokedAt` y su motivo se quedan como
   * están, y quien la elige comprueba antes que no lo esté. Pagar de nuevo no
   * puede ser la forma de deshacer una revocación por uso compartido.
   */
  extend(id, { expiresAt, topes }, cliente = prisma) {
    return cliente.license.update({
      where: { id },
      data: { expiresAt, status: 'ACTIVE', ...topes },
      select: licenseSelect,
    });
  },

  /** Licencia por el hash de su token. Es la consulta del camino caliente. */
  findByTokenHash(tokenHash) {
    return prisma.license.findUnique({
      where: { tokenHash },
      select: {
        ...licenseSelect,
        userId: true,
        user: { select: { id: true, email: true, status: true, firstName: true } },
      },
    });
  },

  listForUser(userId) {
    return prisma.license.findMany({
      where: { userId },
      select: {
        ...licenseSelect,
        counter: {
          select: {
            callsToday: true,
            callsMonth: true,
            costCentsMonth: true,
            dayStamp: true,
            monthStamp: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Licencia del usuario indicado: impide tocar la de otro por su id. */
  findOwned(id, userId) {
    return prisma.license.findFirst({ where: { id, userId }, select: licenseSelect });
  },

  /** Sustituye el token. La URL anterior deja de servir en el acto. */
  replaceToken(id, { tokenHash, tokenHint }) {
    return prisma.license.update({
      where: { id },
      data: { tokenHash, tokenHint },
      select: licenseSelect,
    });
  },

  listAll({ status, limit = 100 } = {}) {
    return prisma.license.findMany({
      where: status ? { status } : {},
      select: {
        ...licenseSelect,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  findById(id) {
    return prisma.license.findUnique({ where: { id }, select: licenseSelect });
  },

  setStatus(id, { status, revokedReason }) {
    return prisma.license.update({
      where: { id },
      data: {
        status,
        revokedAt: status === 'ACTIVE' ? null : new Date(),
        revokedReason: status === 'ACTIVE' ? null : (revokedReason ?? null),
      },
      select: licenseSelect,
    });
  },

  // ── Uso ──────────────────────────────────────────────────────────────────

  /** Registra la llamada y actualiza los contadores de la licencia. */
  recordUsage({
    licenseId,
    tool,
    promptHash,
    sessionId,
    ok = true,
    durationMs,
    kind = 'NORMAL',
    inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0,
    costCents = 0,
  }) {
    return prisma.$transaction([
      prisma.licenseUsage.create({
        data: {
          licenseId,
          tool,
          promptHash,
          sessionId,
          ok,
          durationMs,
          kind,
          inputTokens,
          outputTokens,
          cachedTokens,
          costCents,
        },
      }),
      prisma.license.update({
        where: { id: licenseId },
        data: { callsTotal: { increment: 1 }, lastUsedAt: new Date() },
      }),
    ]);
  },

  usagesSince(licenseId, desde) {
    return prisma.licenseUsage.findMany({
      where: { licenseId, createdAt: { gte: desde } },
      select: { createdAt: true, promptHash: true, sessionId: true, tool: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  countUsagesBetween(licenseId, desde, hasta) {
    return prisma.licenseUsage.count({
      where: { licenseId, createdAt: { gte: desde, lt: hasta } },
    });
  },

  recentUsages(licenseId, { limit = 50 } = {}) {
    return prisma.licenseUsage.findMany({
      where: { licenseId },
      select: { id: true, tool: true, sessionId: true, ok: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};

module.exports = licenseRepository;
