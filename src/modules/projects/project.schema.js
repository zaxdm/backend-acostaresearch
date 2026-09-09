'use strict';

const { z } = require('zod');

const ESTADOS = ['PENDIENTE', 'EN_CURSO', 'LISTO'];

/**
 * Lo que puede escribir el asistente.
 *
 * Los topes son generosos pero existen, y por una razón concreta: al otro lado
 * hay un modelo de lenguaje al que se le ha pedido «resume lo que quedó
 * decidido». Sin límite, un día manda el capítulo entero, y esto dejaría de ser
 * una memoria para convertirse en un almacén de texto que nadie vuelve a leer.
 *
 * El recorte se hace en el esquema y no en la base para que el aviso llegue al
 * asistente —que puede reintentar más corto— en vez de guardarse a medias.
 */
const guardarAvanceSchema = z.object({
  capitulo: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional(),
  estado: z.enum(ESTADOS).optional(),
  resumen: z
    .string()
    .trim()
    .max(1500, 'El resumen del capítulo no puede pasar de 1500 caracteres. Sé más breve.')
    .optional(),
  tema: z.string().trim().max(500).optional(),
  carrera: z.string().trim().max(160).optional(),
  universidad: z.string().trim().max(160).optional(),
});

module.exports = { guardarAvanceSchema, ESTADOS };
