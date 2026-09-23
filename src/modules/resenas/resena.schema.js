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
  comentario: texto(20, 1500, 'Cuéntanos cómo te fue, con al menos una frase.'),
  // Se rellena solo con el nombre de la cuenta, pero se puede cambiar: hay
  // quien no quiere su apellido completo debajo de su opinión.
  nombre: texto(2, 120, 'Escribe con qué nombre quieres que salga.'),
  oficio: z.string().trim().max(120, 'Como mucho 120 caracteres.').optional().default(''),
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
  revisionSchema,
  idParamSchema,
  adminQuerySchema,
  publicasQuerySchema,
};
