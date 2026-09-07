'use strict';

const { z } = require('zod');

const generateCodesSchema = z.object({
  cantidad: z.coerce.number().int().positive().max(100).default(1),
  productCode: z.string().trim().toUpperCase().max(40).optional(),
  buyerEmail: z.string().trim().toLowerCase().email().optional(),
  note: z.string().trim().max(255).optional(),
  // Caducidad del código sin canjear, en días. Omitir = no caduca.
  expiraEnDias: z.coerce.number().int().positive().max(365).optional(),
  // ── El cobro que hay detrás ───────────────────────────────────────────────
  // Mismo vocabulario que las bolsas de palabras: los dos describen dinero que
  // entró fuera de la web, y dos listas distintas para lo mismo acabarían
  // divergiendo. CORTESIA es un regalo y no registra cobro.
  paymentMethod: z
    .enum(['YAPE', 'PLIN', 'TRANSFERENCIA', 'PAYPAL', 'WESTERN_UNION', 'CORTESIA'])
    .default('CORTESIA'),
  paymentRef: z.string().trim().max(80).optional(),
  // Lo realmente cobrado, en soles. Omitirlo toma el precio del plan, que es lo
  // normal: se cobra el precio de la web y teclearlo otra vez solo añade erratas.
  importe: z.coerce.number().nonnegative().max(100000).optional(),
});

const redeemSchema = z.object({
  code: z
    .string({ required_error: 'Escribe el código de activación.' })
    .trim()
    .min(6, 'El código está incompleto.')
    .max(40),
});

const revokeSchema = z.object({
  reason: z.string().trim().max(255).optional(),
});

/**
 * Mover una licencia a otro producto.
 *
 * Es el `productCode`, no el `code` del plan: varios planes pueden vender el
 * mismo producto —uno suelto y otro en oferta— y lo que decide qué capítulos ve
 * el comprador es el producto.
 */
const changeProductSchema = z.object({
  productCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Dime a qué producto la muevo.')
    .max(40),
});

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

const listQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(),
  productCode: z.string().trim().toUpperCase().max(40).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

module.exports = {
  generateCodesSchema,
  redeemSchema,
  revokeSchema,
  changeProductSchema,
  idParamSchema,
  listQuerySchema,
};
