'use strict';

const prisma = require('../../lib/prisma');

const planSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  kind: true,
  productCode: true,
  words: true,
  priceCents: true,
  currency: true,
  priceUsdCents: true,
  listPriceCents: true,
  durationDays: true,
};

const packSelect = {
  id: true,
  wordsTotal: true,
  wordsUsed: true,
  status: true,
  activatedAt: true,
  expiresAt: true,
  plan: { select: { code: true, name: true } },
};

/** Una bolsa sirve si está activa, no ha caducado y le quedan palabras. */
function bolsasUtilizables(userId) {
  return {
    userId,
    status: 'ACTIVE',
    expiresAt: { gt: new Date() },
  };
}

const billingRepository = {
  planSelect,
  packSelect,

  /**
   * La lista pública: la página de precios y el asistente.
   *
   * Sin los planes en prueba (`soloPara`), que están activos pero no se venden:
   * ver `plan.visibilidad`.
   */
  listPlans({ incluirInactivos = false } = {}) {
    return prisma.plan.findMany({
      where: incluirInactivos ? {} : { active: true, soloPara: null },
      select: planSelect,
      orderBy: { sortOrder: 'asc' },
    });
  },

  findPlanByCode(code) {
    return prisma.plan.findUnique({ where: { code } });
  },

  findPlanById(id) {
    return prisma.plan.findUnique({ where: { id } });
  },

  /**
   * Bolsas vigentes, la que antes caduca primero: así se consume lo que está a
   * punto de vencer y no se le pierde saldo al usuario.
   */
  findUsablePacks(userId) {
    return prisma.wordPack.findMany({
      where: bolsasUtilizables(userId),
      orderBy: { expiresAt: 'asc' },
    });
  },

  listPacksForUser(userId) {
    return prisma.wordPack.findMany({
      where: { userId },
      select: packSelect,
      orderBy: { activatedAt: 'desc' },
      take: 20,
    });
  },

  /** ¿Ya se le dio alguna vez la prueba gratuita? Solo una por cuenta. */
  hasEverHadPlan(userId, planId) {
    return prisma.wordPack.findFirst({ where: { userId, planId }, select: { id: true } });
  },

  createPack(data) {
    return prisma.wordPack.create({ data, select: packSelect });
  },

  /**
   * Descuenta palabras repartiéndolas entre las bolsas vigentes, empezando por
   * la que antes caduca. Va en transacción: o se descuenta todo o nada.
   */
  consumeWords(userId, palabras) {
    return prisma.$transaction(async (tx) => {
      const bolsas = await tx.wordPack.findMany({
        where: bolsasUtilizables(userId),
        orderBy: { expiresAt: 'asc' },
      });

      let pendiente = palabras;

      for (const bolsa of bolsas) {
        if (pendiente <= 0) break;

        const disponible = bolsa.wordsTotal - bolsa.wordsUsed;
        if (disponible <= 0) continue;

        const aDescontar = Math.min(disponible, pendiente);
        const usadasTotal = bolsa.wordsUsed + aDescontar;

        /**
         * El descuento va CONDICIONADO a que la bolsa siga como se leyó.
         *
         * Con `update` a secas, dos reescrituras a la vez leían las mismas
         * `wordsUsed` y la segunda escribía encima de la primera: la bolsa
         * gastaba el doble de lo que descontaba. Si otro se adelantó, `count`
         * es 0 y esta bolsa se reintenta con lo que tenga ahora.
         */
        const { count } = await tx.wordPack.updateMany({
          where: { id: bolsa.id, wordsUsed: bolsa.wordsUsed },
          data: {
            wordsUsed: usadasTotal,
            // Marcarla agotada evita seguir consultándola en cada petición.
            status: usadasTotal >= bolsa.wordsTotal ? 'EXHAUSTED' : 'ACTIVE',
          },
        });

        if (count === 0) {
          const ahora = await tx.wordPack.findUnique({ where: { id: bolsa.id } });
          if (!ahora) continue;
          bolsas.push(ahora);
          continue;
        }

        pendiente -= aDescontar;
      }

      return palabras - pendiente;
    });
  },

  /**
   * Devuelve palabras a las bolsas de las que salieron.
   *
   * Se reponen en la que caduca más tarde primero: al revés que al gastar. Lo
   * que se reservó para algo que falló vuelve así a la bolsa con más vida, que
   * es lo que le conviene a quien pagó.
   */
  devolverPalabras(userId, palabras) {
    return prisma.$transaction(async (tx) => {
      const bolsas = await tx.wordPack.findMany({
        where: { userId, wordsUsed: { gt: 0 } },
        orderBy: { expiresAt: 'desc' },
      });

      let pendiente = palabras;

      for (const bolsa of bolsas) {
        if (pendiente <= 0) break;

        const aDevolver = Math.min(bolsa.wordsUsed, pendiente);
        const { count } = await tx.wordPack.updateMany({
          where: { id: bolsa.id, wordsUsed: bolsa.wordsUsed },
          data: {
            wordsUsed: bolsa.wordsUsed - aDevolver,
            // Deja de estar agotada si vuelve a tener hueco.
            status: bolsa.expiresAt > new Date() ? 'ACTIVE' : bolsa.status,
          },
        });

        if (count > 0) pendiente -= aDevolver;
      }

      return palabras - pendiente;
    });
  },

  listRecentPacks({ limit = 50 } = {}) {
    return prisma.wordPack.findMany({
      select: {
        ...packSelect,
        paymentMethod: true,
        paymentRef: true,
        amountCents: true,
        note: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { activatedAt: 'desc' },
      take: limit,
    });
  },
};

module.exports = billingRepository;
