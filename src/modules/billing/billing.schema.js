'use strict';

const { z } = require('zod');

const grantPackSchema = z.object({
  email: z
    .string({ required_error: 'Indica el correo del usuario.' })
    .trim()
    .toLowerCase()
    .email('El correo no tiene un formato válido.'),
  planCode: z
    .string({ required_error: 'Indica el código del plan.' })
    .trim()
    .toUpperCase()
    .max(40),
  paymentMethod: z
    .enum(['YAPE', 'PLIN', 'TRANSFERENCIA', 'PAYPAL', 'WESTERN_UNION', 'CORTESIA'])
    .default('YAPE'),
  // Código de operación del Yape o la transferencia, para poder rastrear el cobro.
  paymentRef: z.string().trim().max(80).optional(),
  // Lo realmente cobrado, en céntimos. Si se omite, se toma el precio del plan.
  amountCents: z.coerce.number().int().nonnegative().optional(),
  note: z.string().trim().max(255).optional(),
});

/**
 * Alta de un código de descuento. El mínimo de S/10 se valida aquí y también en
 * el servicio: aquí para dar un mensaje claro al administrador, allí porque el
 * servicio también se usa desde scripts.
 */
const createDiscountSchema = z.object({
  // Opcional: si no se manda, el servidor inventa uno legible.
  code: z.string().trim().toUpperCase().min(4).max(40).optional(),
  amountCents: z.coerce
    .number({ required_error: 'Indica cuánto descuenta.' })
    .int()
    .min(1000, 'El descuento mínimo es de S/ 10.00.')
    .max(100000),
  planCode: z.string().trim().toUpperCase().max(40).optional(),
  maxUses: z.coerce.number().int().min(0).max(10000).default(0),
  expiraEnDias: z.coerce.number().int().positive().max(365).optional(),
  note: z.string().trim().max(255).optional(),
});

const discountIdParamSchema = z.object({ id: z.string().uuid('Identificador no válido.') });

const validateDiscountSchema = z.object({
  code: z.string({ required_error: 'Escribe el código.' }).trim().min(3).max(40),
  planCode: z.string({ required_error: 'Indica el plan.' }).trim().toUpperCase().max(40),
});

module.exports = {
  grantPackSchema,
  createDiscountSchema,
  discountIdParamSchema,
  validateDiscountSchema,
};
