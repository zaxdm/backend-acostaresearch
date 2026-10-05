'use strict';

const { z } = require('zod');
const { lineasDelCarrito } = require('./payment.schema');

/**
 * El carrito en la query, porque el cuerpo es la imagen: `PLAN:CODIGO,PLAN2`.
 * El código de descuento de cada línea es opcional. Se convierte aquí en la
 * misma lista que llega en JSON a la pasarela, y se valida igual.
 */
const carritoEnLaQuery = z
  .string()
  .trim()
  .max(400)
  .transform((texto) =>
    texto
      .split(',')
      .map((parte) => parte.trim())
      .filter(Boolean)
      .map((parte) => {
        const [planCode, discountCode] = parte.split(':').map((trozo) => trozo.trim());
        return { planCode, ...(discountCode ? { discountCode } : {}) };
      }),
  )
  .pipe(lineasDelCarrito);

/**
 * Datos que acompañan a la captura.
 *
 * Viajan en la query porque el cuerpo de esa petición es la imagen entera. El
 * precio NO está aquí: lo calcula el servidor a partir del plan, igual que en
 * PayPal. Si el importe llegara desde el navegador, cualquiera podría declarar
 * que pagó un sol.
 */
const registrarQuerySchema = z
  .object({
  // Compra suelta: un plan. Con carrito llega `items` en su lugar.
  planCode: z.string().trim().toUpperCase().max(40).optional(),
  items: carritoEnLaQuery.optional(),
  discountCode: z.string().trim().max(40).optional(),
  // El número de operación de Yape. Es opcional porque no todo el mundo lo
  // encuentra, pero es lo que de verdad permite cuadrarlo con el extracto, así
  // que la web lo pide con insistencia.
  operationCode: z.string().trim().max(40).optional(),
  // Por dónde pagó. Sin él es Yape, que es lo que mandaba la web de antes.
  metodo: z.enum(['YAPE', 'WESTERN_UNION']).default('YAPE'),
  })
  .refine((datos) => Boolean(datos.planCode) !== Boolean(datos.items), {
    message: 'Indica el plan que estás pagando.',
    path: ['planCode'],
  })
  // En Western Union el MTCN no es opcional: son los 10 dígitos con los que se
  // cobra el giro en la agencia. Sin él no hay forma de recibir el dinero.
  .refine(
    (datos) =>
      datos.metodo !== 'WESTERN_UNION' ||
      /^\d{10}$/.test((datos.operationCode || '').replace(/[\s-]/g, '')),
    {
      message: 'Escribe el MTCN de tu envío: son 10 dígitos.',
      path: ['operationCode'],
    },
  )
  .transform((datos) =>
    datos.metodo === 'WESTERN_UNION'
      ? { ...datos, operationCode: datos.operationCode.replace(/[\s-]/g, '') }
      : datos,
  );

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
