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
  // El número de operación de Yape (o el MTCN). Obligatorio desde el 8-oct:
  // es lo que de verdad permite cuadrarlo con el extracto, y opcional llegaban
  // fotos cualquiera sin nada que cotejar.
  operationCode: z.string().trim().max(40).optional(),
  // Por dónde pagó. Sin él es Yape, que es lo que mandaba la web de antes.
  metodo: z.enum(['YAPE', 'WESTERN_UNION']).default('YAPE'),
  // La billetera de país por la que pagó. Si viene, manda sobre `metodo`.
  billetera: z.string().uuid('Esa billetera no es válida.').optional(),
  })
  .refine((datos) => Boolean(datos.planCode) !== Boolean(datos.items), {
    message: 'Indica el plan que estás pagando.',
    path: ['planCode'],
  })
  // En Western Union el MTCN no es opcional: son los 10 dígitos con los que se
  // cobra el giro en la agencia. Sin él no hay forma de recibir el dinero.
  .refine(
    (datos) =>
      Boolean(datos.billetera) ||
      datos.metodo !== 'WESTERN_UNION' ||
      /^\d{10}$/.test((datos.operationCode || '').replace(/[\s-]/g, '')),
    {
      message: 'Escribe el MTCN de tu envío: son 10 dígitos.',
      path: ['operationCode'],
    },
  )
  // En Yape (o Plin), el número de operación de la constancia: solo cifras,
  // entre 6 y 12. Yape enseña 8; el margen es para Plin y los bancos.
  .refine(
    (datos) =>
      Boolean(datos.billetera) ||
      datos.metodo !== 'YAPE' ||
      /^\d{6,12}$/.test((datos.operationCode || '').replace(/[\s-]/g, '')),
    {
      message:
        'Escribe el número de operación de tu Yape: está en la constancia, debajo del monto (solo números).',
      path: ['operationCode'],
    },
  )
  // Cada billetera numera sus operaciones a su manera: solo se exige que venga.
  .refine(
    (datos) =>
      !datos.billetera || /^[A-Za-z0-9]{4,40}$/.test((datos.operationCode || '').replace(/[\s-]/g, '')),
    {
      message: 'Escribe el número de operación o de comprobante de tu pago (letras y números).',
      path: ['operationCode'],
    },
  )
  .transform((datos) => ({ ...datos, operationCode: datos.operationCode.replace(/[\s-]/g, '') }));

/**
 * La revisión previa de la captura, antes de enviarla. El importe lo manda la
 * web y no se le cree para nada: solo sirve para buscarlo en la imagen y
 * avisar si no aparece.
 */
const revisarCapturaQuerySchema = z.object({
  metodo: z.enum(['YAPE', 'WESTERN_UNION']).default('YAPE'),
  monto: z.coerce.number().int().min(0).max(10_000_000).optional(),
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

const texto = (campo, maximo) =>
  z
    .string({ required_error: `${campo} es obligatorio.` })
    .trim()
    .min(2, `${campo} es demasiado corto.`)
    .max(maximo, `${campo} no puede pasar de ${maximo} caracteres.`);

/** El alta de una billetera de país. País y moneda se eligen aquí y ya no se cambian. */
const crearBilleteraSchema = z.object({
  nombre: texto('El nombre', 60),
  pais: z
    .string({ required_error: 'Elige el país.' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'El país va con su código de dos letras: EC, CO, MX…'),
  moneda: z.enum(['PEN', 'USD'], { errorMap: () => ({ message: 'La moneda es PEN o USD.' }) }),
  titular: texto('El titular', 120),
  numero: texto('El número o la cuenta', 80),
  instrucciones: z.string().trim().max(500).optional(),
});

const cambiarBilleteraSchema = z.object({
  nombre: texto('El nombre', 60).optional(),
  titular: texto('El titular', 120).optional(),
  numero: texto('El número o la cuenta', 80).optional(),
  instrucciones: z.string().trim().max(500).optional(),
  active: z.boolean().optional(),
});

module.exports = {
  crearBilleteraSchema,
  cambiarBilleteraSchema,
  registrarQuerySchema,
  revisarCapturaQuerySchema,
  paymentParamsSchema,
  rechazarSchema,
};
