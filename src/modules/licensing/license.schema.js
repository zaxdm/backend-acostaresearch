'use strict';

const { z } = require('zod');

const { revisarCorreo } = require('../../shared/utils/correo');

/** Tope de códigos por venta, sumando los de todos los compradores. */
const MAXIMO_CODIGOS = 100;

/**
 * Un correo al que se le va a mandar un código cobrado.
 *
 * No basta con `.email()`: `kelin@gamail.com` tiene la forma perfecta y salió.
 * El mensaje lleva el correo delante porque en una lista de treinta hay que
 * saber cuál es el que falla.
 */
const correoDeComprador = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((valor, ctx) => {
    const { problema, sugerencia } = revisarCorreo(valor);
    if (!problema) return;
    ctx.addIssue({
      code: 'custom',
      message: sugerencia
        ? `${valor}: ${problema} ¿Quisiste decir ${sugerencia}?`
        : `${valor}: ${problema}`,
    });
  });

const generateCodesSchema = z
  .object({
    cantidad: z.coerce.number().int().positive().max(MAXIMO_CODIGOS).default(1),
    productCode: z.string().trim().toUpperCase().max(40).optional(),
    buyerEmail: correoDeComprador.optional(),
    // Varios compradores de una vez, al mismo precio: cada uno recibe sus
    // `cantidad` códigos en su correo. Excluye a `buyerEmail`.
    buyerEmails: z.array(correoDeComprador).min(1).max(MAXIMO_CODIGOS).optional(),
    note: z.string().trim().max(255).optional(),
    // Caducidad del código sin canjear, en días. Omitir = no caduca.
    expiraEnDias: z.coerce.number().int().positive().max(365).optional(),
    // ── El cobro que hay detrás ─────────────────────────────────────────────
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
  })
  .superRefine((datos, ctx) => {
    if (datos.buyerEmail && datos.buyerEmails) {
      ctx.addIssue({
        code: 'custom',
        path: ['buyerEmails'],
        message: 'Indica un correo o una lista, no las dos cosas.',
      });
    }

    const compradores = datos.buyerEmails ? new Set(datos.buyerEmails).size : 1;
    if (compradores * datos.cantidad > MAXIMO_CODIGOS) {
      ctx.addIssue({
        code: 'custom',
        path: ['cantidad'],
        message: `Son ${compradores * datos.cantidad} códigos; el máximo por venta es ${MAXIMO_CODIGOS}.`,
      });
    }
  });

/** Correos que el panel quiere comprobar antes de generar. */
const checkEmailsSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().max(255)).min(1).max(MAXIMO_CODIGOS),
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
  checkEmailsSchema,
  redeemSchema,
  revokeSchema,
  changeProductSchema,
  idParamSchema,
  listQuerySchema,
};
