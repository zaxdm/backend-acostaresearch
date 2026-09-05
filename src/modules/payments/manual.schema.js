'use strict';

const { z } = require('zod');

/**
 * Datos que acompañan a la captura.
 *
 * Viajan en la query porque el cuerpo de esa petición es la imagen entera. El
 * precio NO está aquí: lo calcula el servidor a partir del plan, igual que en
 * PayPal. Si el importe llegara desde el navegador, cualquiera podría declarar
 * que pagó un sol.
 */
const registrarQuerySchema = z.object({
  planCode: z
    .string({ required_error: 'Indica el plan que estás pagando.' })
    .trim()
    .toUpperCase()
    .max(40),
  discountCode: z.string().trim().max(40).optional(),
  // El número de operación de Yape. Es opcional porque no todo el mundo lo
  // encuentra, pero es lo que de verdad permite cuadrarlo con el extracto, así
  // que la web lo pide con insistencia.
  operationCode: z.string().trim().max(40).optional(),
});

const paymentParamsSchema = z.object({
  id: z.string().uuid('Identificador de pago no válido.'),
});

/**
 * Motivo del rechazo.
 *
 * Es obligatorio y no admite dos palabras: este texto se le manda al comprador
 * tal cual, y «no válido» no le dice qué corregir. Que cueste escribirlo es
 * parte de lo que se pretende.
 */
const rechazarSchema = z.object({
  motivo: z
    .string({ required_error: 'Escribe por qué no lo das por bueno: el comprador va a leerlo.' })
    .trim()
    .min(10, 'Explícalo un poco más: el comprador solo va a leer esto.')
    .max(255),
});

module.exports = { registrarQuerySchema, paymentParamsSchema, rechazarSchema };
