'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const billingService = require('./billing.service');
const discountService = require('./discount.service');
const { addDays } = require('../../shared/utils/tokens');

const billingController = {
  plans: asyncHandler(async (_req, res) => {
    const plans = await billingService.listPlans();
    return ok(res, { plans });
  }),

  balance: asyncHandler(async (req, res) => {
    const balance = await billingService.getBalance(req.user.id);
    return ok(res, { balance });
  }),

  grant: asyncHandler(async (req, res) => {
    const resultado = await billingService.grantPack({
      ...req.body,
      grantedById: req.user.id,
    });
    return created(res, resultado, 'Bolsa de palabras activada.');
  }),

  /** Comprueba un código y devuelve el precio que quedaría. Es público-con-sesión. */
  validateDiscount: asyncHandler(async (req, res) => {
    const plan = await billingService.findPlan(req.body.planCode);
    const discount = await discountService.resolve({ code: req.body.code, plan });
    return ok(res, { discount }, { message: 'Código aplicado.' });
  }),

  createDiscount: asyncHandler(async (req, res) => {
    const { expiraEnDias, ...resto } = req.body;
    const discount = await discountService.create({
      ...resto,
      createdById: req.user.id,
      expiresAt: expiraEnDias ? addDays(new Date(), expiraEnDias) : undefined,
    });
    return created(res, { discount }, 'Código de descuento creado.');
  }),

  discounts: asyncHandler(async (_req, res) => {
    const discounts = await discountService.list();
    return ok(res, { discounts });
  }),

  toggleDiscount: asyncHandler(async (req, res) => {
    const discount = await discountService.setActive(req.params.id, req.body.active !== false);
    return ok(res, { discount });
  }),

  recent: asyncHandler(async (_req, res) => {
    const packs = await billingService.listRecentPacks();
    return ok(res, { packs });
  }),
};

module.exports = billingController;
