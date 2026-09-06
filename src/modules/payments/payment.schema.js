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
  // Código promocional. El servidor calcula la rebaja; aquí solo viaja el código.
  discountCode: z.string().trim().max(40).optional(),
});

const orderParamsSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
});

const providerQuerySchema = z.object({
  provider: z.string().trim().toUpperCase().max(20).default('PAYPAL'),
});

/** El identificador del pago en nuestra base, no el de la pasarela. */
const paymentIdParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = {
  createOrderSchema,
  orderParamsSchema,
  providerQuerySchema,
  paymentIdParamSchema,
};
