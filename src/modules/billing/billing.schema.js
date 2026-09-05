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

const CODIGO_GRUPO = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * Alta de un grupo.
 *
 * El código se normaliza a MAYÚSCULAS_CON_GUION_BAJO porque va a viajar en
 * la URL del conector y en cada licencia emitida: conviene que sea legible de
 * un vistazo en un log y que no dependa de si alguien escribió mayúsculas.
 */
const createProductSchema = z.object({
  code: z
    .string({ required_error: 'Ponle un código al grupo.' })
    .trim()
    .toUpperCase()
    .min(3)
    .max(40)
    .regex(CODIGO_GRUPO, 'Solo letras, números y guion bajo. Ejemplo: HUMANIZAR_TEXTO.'),
  name: z.string({ required_error: 'Ponle un nombre visible.' }).trim().min(3).max(80),
  description: z.string().trim().max(255).optional(),
  // En céntimos, como el resto del sistema: en soles y con decimales, un
  // redondeo mal hecho se convierte en un cobro mal hecho.
  priceCents: z.coerce.number({ required_error: 'Indica el precio.' }).int().min(0).max(1000000),
  priceUsdCents: z.coerce.number().int().min(0).max(1000000).optional(),
  // 0 = sin caducidad. Cualquier otro valor son días de acceso.
  durationDays: z.coerce.number().int().min(0).max(3650).default(90),
  mcpCallsPerDay: z.coerce.number().int().min(0).max(100000).optional(),
  mcpDelivery: z.enum(['INSTRUCTIONS', 'EXECUTED']).optional(),
  active: z.coerce.boolean().optional(),
});

const updateProductSchema = z
  .object({
    name: z.string().trim().min(3).max(80).optional(),
    description: z.string().trim().max(255).nullable().optional(),
    priceCents: z.coerce.number().int().min(0).max(1000000).optional(),
    priceUsdCents: z.coerce.number().int().min(0).max(1000000).nullable().optional(),
    durationDays: z.coerce.number().int().min(0).max(3650).optional(),
    mcpCallsPerDay: z.coerce.number().int().min(0).max(100000).optional(),
    active: z.boolean().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, 'No hay nada que cambiar.');

const productCodeParamSchema = z.object({
  code: z.string().trim().toUpperCase().min(3).max(40),
});

module.exports = {
  grantPackSchema,
  createProductSchema,
  updateProductSchema,
  productCodeParamSchema,
  createDiscountSchema,
  discountIdParamSchema,
  validateDiscountSchema,
};
