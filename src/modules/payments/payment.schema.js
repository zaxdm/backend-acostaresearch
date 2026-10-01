'use strict';

const { z } = require('zod');

/** Más que esto no es un carrito, es un error o un abuso. Hoy se venden tres productos. */
const MAX_PRODUCTOS = 5;

const codigoDePlan = z.string().trim().toUpperCase().max(40);
const codigoDeDescuento = z.string().trim().max(40).optional();

/**
 * Una línea del carrito: qué plan y, si lo hay, con qué código de descuento.
 * Cada producto lleva el suyo porque los códigos anunciados son por plan.
 */
const lineaDelCarrito = z.object({
  planCode: codigoDePlan,
  discountCode: codigoDeDescuento,
});

/** Las líneas del carrito: de una a `MAX_PRODUCTOS`, sin repetir plan. */
const lineasDelCarrito = z
  .array(lineaDelCarrito)
  .min(1, 'El carrito está vacío.')
  .max(MAX_PRODUCTOS, `En el carrito caben hasta ${MAX_PRODUCTOS} productos.`)
  .refine(
    (lineas) => new Set(lineas.map((l) => l.planCode)).size === lineas.length,
    'Hay un producto repetido en el carrito.',
  );

/**
 * El navegador solo dice QUÉ plan quiere y por dónde paga. El precio lo pone
 * siempre el servidor: si el importe llegara desde el cliente, cualquiera
 * podría comprar el plan grande por un céntimo.
 */
const createOrderSchema = z
  .object({
    // Compra suelta: un plan. Con carrito llega `items` en su lugar.
    planCode: codigoDePlan.optional(),
    items: lineasDelCarrito.optional(),
    provider: z.string().trim().toUpperCase().max(20).default('PAYPAL'),
    // Código promocional. El servidor calcula la rebaja; aquí solo viaja el código.
    discountCode: codigoDeDescuento,
  })
  .refine((datos) => Boolean(datos.planCode) !== Boolean(datos.items), {
    message: 'Indica el plan que quieres comprar.',
    path: ['planCode'],
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

/**
 * Al cancelar, el navegador puede decir por qué: el error que dio el botón de
 * PayPal. Solo se guarda y se anota en el log; no decide nada.
 */
const cancelBodySchema = z
  .object({ motivo: z.string().trim().max(200).optional() })
  .default({});

const providerQuerySchema = z.object({
  provider: z.string().trim().toUpperCase().max(20).default('PAYPAL'),
});

/** El identificador del pago en nuestra base, no el de la pasarela. */
const paymentIdParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = {
  MAX_PRODUCTOS,
  lineasDelCarrito,
  createOrderSchema,
  orderParamsSchema,
  captureBodySchema,
  cancelBodySchema,
  providerQuerySchema,
  paymentIdParamSchema,
};
