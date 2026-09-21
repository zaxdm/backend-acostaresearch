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

/** Parámetros de 3-D Secure que devuelve la verificación del banco. */
const autenticacion3DS = z
  .object({
    eci: z.string().trim().max(10).optional(),
    xid: z.string().trim().max(200).optional(),
    cavv: z.string().trim().max(200).optional(),
    protocolVersion: z.string().trim().max(20).optional(),
    directoryServerTransactionId: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * Lo que el navegador manda al confirmar. PayPal no manda nada (llega `{}`);
 * Culqi manda el token de un solo uso de su formulario. El importe NO viaja:
 * se cobra el que quedó guardado al abrir la orden.
 *
 * `.default({})`: una confirmación sin cuerpo sigue siendo válida, como hasta
 * ahora con PayPal.
 */
const captureBodySchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^(tkn|ype)_(test|live)_[A-Za-z0-9]+$/, 'Token de pago no válido.')
      .max(60)
      .optional(),
    email: z.string().trim().toLowerCase().email('Correo no válido.').max(50).optional(),
    deviceFingerprint: z.string().trim().max(100).optional(),
    authentication3DS: autenticacion3DS.optional(),
  })
  .default({});

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
  captureBodySchema,
  providerQuerySchema,
  paymentIdParamSchema,
};
