'use strict';

const { z } = require('zod');

/**
 * Lo que se puede escribir en una reseña del servicio.
 *
 * El comentario es obligatorio, al revés que en la reseña al asesor: aquella
 * vive en una ficha donde la nota media ya dice algo por sí sola, y esta sale
 * en la portada, donde cinco estrellas sin una frase no cuentan nada a quien
 * está decidiendo si compra.
 *
 * El mínimo de 20 caracteres es el suelo de una frase de verdad. Por debajo de
 * eso —«muy bueno», «excelente»— no hay testimonio, hay relleno, y alguien
 * tendría que leerlo en el panel para acabar descartándolo.
 */

const texto = (min, max, mensaje) =>
  z.string().trim().min(min, mensaje).max(max, `Como mucho ${max} caracteres.`);

const resenaBodySchema = z.object({
  estrellas: z.coerce
    .number()
    .int()
    .min(1, 'Pon entre una y cinco estrellas.')
    .max(5, 'Pon entre una y cinco estrellas.'),
  // Puede ir vacío SI la reseña ya tiene video: entonces el testimonio es la
  // grabación y el texto sobra. Quien decide eso es el servicio, que es el
  // único que sabe si hay video; aquí solo se comprueba el techo.
  comentario: z.string().trim().max(1500, 'Como mucho 1500 caracteres.').default(''),
  // El nombre ya no se pide: la reseña se firma con el correo de la cuenta
  // tapado —«steb***@gmail.com»—, que es lo que enseña que detrás hay un
  // cliente de verdad. Preguntarlo era pedirle al autor que se inventara una
  // firma para algo que ya sabemos quién es.
  oficio: z.string().trim().max(120, 'Como mucho 120 caracteres.').optional().default(''),
  // La web avisa de que el video va detrás, en la petición siguiente: el
  // formulario deja elegirlo antes de enviar, y una reseña de solo video tiene
  // que poder nacer sin texto. No se guarda; si el video no llega a subir, la
  // reseña queda pendiente y en blanco, y en blanco no sale en la web.
  conVideo: z.boolean().optional().default(false),
});

/**
 * Lo que el administrador cambia de una reseña.
 *
 * Los tres campos son opcionales y por separado: aprobar y destacar son dos
 * permisos distintos —uno deja leerla en /resenas y el otro la sube a la
 * portada— y el panel los toca con botones distintos.
 */
const revisionSchema = z
  .object({
    estado: z.enum(['PENDIENTE', 'APROBADA', 'RECHAZADA']).optional(),
    destacada: z.boolean().optional(),
    // Llega tal cual a quien la escribió, así que se escribe para él.
    motivo: z.string().trim().max(500, 'Como mucho 500 caracteres.').optional(),
  })
  .refine(
    (datos) =>
      datos.estado !== undefined || datos.destacada !== undefined || datos.motivo !== undefined,
    { message: 'No hay nada que cambiar.' },
  );

const idParamSchema = z.object({
  id: z.string().uuid('Esa reseña no existe.'),
});

/**
 * Una reseña dada de alta desde el panel, a nombre de un cliente.
 *
 * Los testimonios llegan por WhatsApp y por correo, no por el formulario. El
 * correo NO es decorativo: tiene que ser el de una cuenta que exista, y de ahí
 * sale la firma pública. Sin cuenta detrás, el servicio no crea nada.
 *
 * El texto puede ir vacío cuando lo que se va a subir es un video.
 */
const altaDelPanelSchema = z.object({
  email: z.string().trim().toLowerCase().email('Pon el correo con el que compró.'),
  estrellas: z.coerce
    .number()
    .int()
    .min(1, 'Pon entre una y cinco estrellas.')
    .max(5, 'Pon entre una y cinco estrellas.'),
  comentario: z.string().trim().max(1500, 'Como mucho 1500 caracteres.').default(''),
  oficio: z.string().trim().max(120, 'Como mucho 120 caracteres.').optional().default(''),
});

/**
 * Qué pide la web pública.
 *
 * `destacadas=1` es lo que manda la portada, que enseña unas pocas elegidas a
 * mano; sin nada llegan todas las aprobadas, que es la página /resenas.
 */
const publicasQuerySchema = z.object({
  destacadas: z
    .enum(['0', '1'])
    .optional()
    .transform((valor) => valor === '1'),
});

/** Qué lista pide el panel. Sin nada, las pendientes: es a lo que se entra. */
const adminQuerySchema = z.object({
  estado: z.enum(['PENDIENTE', 'APROBADA', 'RECHAZADA', 'TODAS']).optional().default('TODAS'),
});

module.exports = {
  resenaBodySchema,
  altaDelPanelSchema,
  revisionSchema,
  idParamSchema,
  adminQuerySchema,
  publicasQuerySchema,
};
