'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const paymentService = require('./payment.service');

const paymentController = {
  providers: asyncHandler(async (_req, res) => {
    return ok(res, { providers: paymentService.listProviders() });
  }),

  createOrder: asyncHandler(async (req, res) => {
    const order = await paymentService.createOrder({
      userId: req.user.id,
      planCode: req.body.planCode,
      providerCode: req.body.provider,
      discountCode: req.body.discountCode,
    });
    return created(res, { order });
  }),

  capture: asyncHandler(async (req, res) => {
    const resultado = await paymentService.captureOrder({
      userId: req.user.id,
      orderId: req.params.orderId,
      providerCode: req.query.provider,
    });

    const mensaje = resultado.alreadyProcessed
      ? 'Este pago ya estaba confirmado.'
      : '¡Pago confirmado! Ya tienes tus palabras disponibles.';

    return ok(res, resultado, { message: mensaje });
  }),

  cancel: asyncHandler(async (req, res) => {
    await paymentService.cancelOrder({
      userId: req.user.id,
      orderId: req.params.orderId,
      providerCode: req.query.provider,
    });
    return noContent(res);
  }),

  mine: asyncHandler(async (req, res) => {
    const payments = await paymentService.listForUser(req.user.id);
    return ok(res, { payments });
  }),

  recent: asyncHandler(async (_req, res) => {
    const payments = await paymentService.listRecent();
    return ok(res, { payments });
  }),

  remove: asyncHandler(async (req, res) => {
    await paymentService.remove({ id: req.params.id, byId: req.user.id });
    return noContent(res);
  }),
};

module.exports = paymentController;
