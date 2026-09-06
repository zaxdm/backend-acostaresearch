'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const billingService = require('./billing.service');
const discountService = require('./discount.service');
const productService = require('./product.service');
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

  // ── Grupos de skills ─────────────────────────────────────────────────────
  //
  // Un grupo es un producto vendible: sus capítulos, su precio y su duración.
  // Se administran aquí y no en el módulo de skills porque lo que se crea es
  // un plan; los capítulos solo se cuelgan de él después.

  products: asyncHandler(async (_req, res) => {
    const products = await productService.list();
    return ok(res, { products });
  }),

  createProduct: asyncHandler(async (req, res) => {
    const product = await productService.create(req.body);
    return created(res, { product }, `Grupo «${product.name}» creado.`);
  }),

  updateProduct: asyncHandler(async (req, res) => {
    const product = await productService.update(req.params.code, req.body);
    return ok(res, { product }, { message: 'Grupo actualizado.' });
  }),

  deleteProduct: asyncHandler(async (req, res) => {
    const product = await productService.remove(req.params.code);
    return ok(res, { product }, { message: `Grupo «${product.name}» eliminado.` });
  }),
};

module.exports = billingController;
