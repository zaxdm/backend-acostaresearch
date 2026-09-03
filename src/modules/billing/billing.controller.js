'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const billingService = require('./billing.service');

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

  recent: asyncHandler(async (_req, res) => {
    const packs = await billingService.listRecentPacks();
    return ok(res, { packs });
  }),
};

module.exports = billingController;
