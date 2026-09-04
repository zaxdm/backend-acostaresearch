'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const billingRepository = require('./billing.repository');
const userRepository = require('../users/user.repository');
const { AppError, NotFoundError } = require('../../shared/errors/AppError');

function sumarDias(fecha, dias) {
  return new Date(fecha.getTime() + dias * 24 * 60 * 60 * 1000);
}

const billingService = {
  listPlans() {
    return billingRepository.listPlans();
  },

  /** Plan activo por su código. Lanza si no existe: lo usan las compras. */
  async findPlan(code) {
    const plan = await billingRepository.findPlanByCode(code);
    if (!plan || !plan.active) {
      throw new NotFoundError(`No existe un plan activo con el código ${code}.`);
    }
    return plan;
  },

  /**
   * Datos de una bolsa nueva a partir de un plan. La regla de caducidad vive
   * aquí y en un solo sitio: la usan tanto la activación manual como la
   * pasarela de pago.
   */
  packDataForPlan({ userId, plan, paymentMethod, paymentRef, amountCents, note, grantedById }) {
    return {
      userId,
      planId: plan.id,
      wordsTotal: plan.words,
      expiresAt: sumarDias(new Date(), plan.durationDays),
      paymentMethod,
      paymentRef,
      amountCents: amountCents ?? plan.priceCents,
      note,
      grantedById,
    };
  },

  /**
   * Saldo del usuario: palabras que puede consumir ahora mismo, sumando todas
   * sus bolsas vigentes.
   */
  async getBalance(userId) {
    const bolsas = await billingRepository.findUsablePacks(userId);

    const disponibles = bolsas.reduce(
      (total, bolsa) => total + Math.max(bolsa.wordsTotal - bolsa.wordsUsed, 0),
      0,
    );

    // La caducidad que más apremia es la de la bolsa que antes vence.
    const proximaCaducidad = bolsas.length > 0 ? bolsas[0].expiresAt : null;

    return {
      wordsAvailable: disponibles,
      maxWordsPerRequest: env.REWRITE_MAX_WORDS_PER_REQUEST,
      expiresAt: proximaCaducidad,
      packs: await billingRepository.listPacksForUser(userId),
    };
  },

  /**
   * Activa una bolsa para un usuario. Hoy la llama un administrador tras
   * confirmar un Yape o una transferencia; cuando haya pasarela, la llamará
   * el webhook de pago con los mismos datos.
   */
  async grantPack({ email, planCode, paymentMethod, paymentRef, amountCents, note, grantedById }) {
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw new NotFoundError(`No hay ninguna cuenta con el correo ${email}.`);
    }

    const plan = await billingRepository.findPlanByCode(planCode);
    if (!plan || !plan.active) {
      throw new NotFoundError(`No existe un plan activo con el código ${planCode}.`);
    }

    const pack = await billingRepository.createPack(
      this.packDataForPlan({
        userId: user.id,
        plan,
        paymentMethod,
        paymentRef,
        amountCents,
        note,
        grantedById,
      }),
    );

    logger.info(
      { userId: user.id, email: user.email, plan: plan.code, palabras: plan.words, paymentRef },
      'Bolsa de palabras activada',
    );

    return { user: { id: user.id, email: user.email }, pack };
  },

  /**
   * Prueba gratuita al crear la cuenta. Solo una vez por usuario: si ya la tuvo,
   * no se repite aunque se vuelva a llamar.
   */
  async grantTrial(userId) {
    const plan = await billingRepository.findPlanByCode(env.TRIAL_PLAN_CODE);
    if (!plan || !plan.active) return null;

    const yaLaTuvo = await billingRepository.hasEverHadPlan(userId, plan.id);
    if (yaLaTuvo) return null;

    return billingRepository.createPack(
      this.packDataForPlan({
        userId,
        plan,
        paymentMethod: 'CORTESIA',
        note: 'Prueba gratuita al crear la cuenta',
      }),
    );
  },

  /** Comprueba que hay saldo antes de gastar dinero en la llamada al modelo. */
  async assertBalance(userId, palabras) {
    const { wordsAvailable, expiresAt } = await this.getBalance(userId);

    if (wordsAvailable <= 0) {
      throw new AppError(
        'No te quedan palabras disponibles. Recarga tu plan para seguir reescribiendo.',
        { statusCode: 402, code: ERROR_CODES.NO_BALANCE, details: { wordsAvailable: 0 } },
      );
    }

    if (palabras > wordsAvailable) {
      throw new AppError(
        `Te quedan ${wordsAvailable} palabras y este texto tiene ${palabras}.`,
        {
          statusCode: 402,
          code: ERROR_CODES.NO_BALANCE,
          details: { wordsAvailable, wordsRequested: palabras, expiresAt },
        },
      );
    }

    return wordsAvailable;
  },

  consumeWords(userId, palabras) {
    return billingRepository.consumeWords(userId, palabras);
  },

  listRecentPacks() {
    return billingRepository.listRecentPacks();
  },
};

module.exports = billingService;
