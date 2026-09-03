'use strict';

const { z } = require('zod');

const rewriteSchema = z.object({
  text: z
    .string({ required_error: 'Escribe o pega el texto que quieres reescribir.' })
    .trim()
    .min(40, 'El texto es demasiado corto: escribe al menos un párrafo.')
    .max(60000, 'El texto es demasiado largo para un solo envío.'),
  mode: z.enum(['LIGERO', 'ESTANDAR', 'PROFUNDO']).default('ESTANDAR'),
  // Cada capítulo tiene convenciones propias; GENERAL vale para texto suelto.
  chapter: z
    .enum([
      'GENERAL',
      'CAP_I_PROBLEMA',
      'CAP_II_MARCO_TEORICO',
      'CAP_III_METODOLOGIA',
      'CAP_IV_RESULTADOS',
      'CAP_V_DISCUSION',
      'CAP_VI_CONCLUSIONES',
      'RESUMEN_ABSTRACT',
    ])
    .default('GENERAL'),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(50).default(20),
});

const idParamSchema = z.object({
  id: z.string().uuid('Identificador inválido.'),
});

module.exports = { rewriteSchema, listQuerySchema, idParamSchema };
