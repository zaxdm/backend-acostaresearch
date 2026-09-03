'use strict';

const { z } = require('zod');

/**
 * El navegador solo dice QUÉ plan quiere y por dónde paga. El precio lo pone
 * siempre el servidor: si el importe llegara desde el cliente, cualquiera
 * podría comprar el plan grande por un céntimo.
 */
const createOrderSchema = z.object({
  planCode: z
    .string({ required_error: 'Indica el plan que quieres comprar.' })
    .trim()
    .toUpperCase()
    .max(40),
  provider: z.string().trim().toUpperCase().max(20).default('PAYPAL'),
});

const orderParamsSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
});

const providerQuerySchema = z.object({
  provider: z.string().trim().toUpperCase().max(20).default('PAYPAL'),
});

module.exports = { createOrderSchema, orderParamsSchema, providerQuerySchema };
