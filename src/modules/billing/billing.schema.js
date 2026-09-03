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

module.exports = { grantPackSchema };
