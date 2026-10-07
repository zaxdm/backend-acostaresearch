'use strict';

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const logger = require('../../config/logger');
const paymentService = require('./payment.service');
const hotmartWebhook = require('./hotmart.webhook');

const paymentController = {
  providers: asyncHandler(async (_req, res) => {
    return ok(res, { providers: paymentService.listProviders() });
  }),

  createOrder: asyncHandler(async (req, res) => {
    const { items } = req.body;

    // Un carrito de un solo producto es una compra suelta: va por el camino
    // de siempre, con su fila sin `cartId`.
    const order =
      items && items.length > 1
        ? await paymentService.createCartOrder({
            userId: req.user.id,
            items,
            providerCode: req.body.provider,
            // El código del carrito rebaja el total, una sola vez.
            discountCode: req.body.discountCode,
          })
        : await paymentService.createOrder({
            userId: req.user.id,
            planCode: items ? items[0].planCode : req.body.planCode,
            providerCode: req.body.provider,
            discountCode: (items && items[0].discountCode) || req.body.discountCode,
          });
    return created(res, { order });
  }),

  capture: asyncHandler(async (req, res) => {
    const resultado = await paymentService.captureOrder({
      userId: req.user.id,
      orderId: req.params.orderId,
      providerCode: req.query.provider,
      datosDelCobro: req.body,
    });

    const mensaje = resultado.requiresAuthentication
      ? 'Tu banco pide confirmar el pago. Sigue los pasos de la verificación.'
      : resultado.alreadyProcessed
        ? 'Este pago ya estaba confirmado.'
        : '¡Pago confirmado! Ya tienes tu acceso.';

    return ok(res, resultado, { message: mensaje });
  }),

  cancel: asyncHandler(async (req, res) => {
    await paymentService.cancelOrder({
      userId: req.user.id,
      orderId: req.params.orderId,
      providerCode: req.query.provider,
      motivo: req.body?.motivo ?? null,
    });
    return noContent(res);
  }),

  /**
   * El aviso de Hotmart. Sin el Hottok correcto no se toca nada. Un error al
   * entregar sube como 500 a propósito: Hotmart reintenta lo que no recibe 200.
   */
  hotmart: asyncHandler(async (req, res) => {
    // La 2.0 lo manda en la cabecera; la 1.0, en el cuerpo.
    const firma = req.get('X-HOTMART-HOTTOK') ?? req.body?.hottok;
    if (!hotmartWebhook.firmaValida(firma)) {
      logger.warn({ evento: req.body?.event }, 'Hotmart: aviso con Hottok inválido');
      return res.status(401).json({ success: false });
    }

    const resultado = await hotmartWebhook.procesarAviso(req.body);
    logger.info({ evento: req.body?.event, ...resultado }, 'Hotmart: aviso procesado');
    return ok(res, resultado);
  }),

  mine: asyncHandler(async (req, res) => {
    const payments = await paymentService.listForUser(req.user.id);
    return ok(res, { payments });
  }),

  recent: asyncHandler(async (_req, res) => {
    const payments = await paymentService.listRecent();
    return ok(res, { payments });
  }),

  constancia: asyncHandler(async (req, res) => {
    const { nombre, pdf } = await paymentService.constancia({
      id: req.params.id,
      userId: req.user.id,
      role: req.user.role,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdf);
  }),

  remove: asyncHandler(async (req, res) => {
    await paymentService.remove({ id: req.params.id, byId: req.user.id });
    return noContent(res);
  }),
};

module.exports = paymentController;
