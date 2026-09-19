'use strict';

const { z } = require('zod');

const anio = z.coerce.number().int().min(1900).max(2100).optional().nullable();

/**
 * Lo que pide el panel para armar un mapa de coocurrencia.
 *
 * `minimo` nulo = que lo elija el servidor (ver `umbralAutomatico`). Los textos
 * de excluir y sinónimos van con techo: son listas que escribe una persona, no
 * un tesauro de diez mil líneas.
 */
const coocurrenciaSchema = z
  .object({
    origen: z.enum(['openalex', 'mis-fuentes']),
    tema: z.string().trim().max(300, 'Resume el tema: con unas palabras basta.').optional(),
    desdeAnio: anio,
    hastaAnio: anio,
    idioma: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/, 'Idioma no válido.')
      .optional()
      .nullable(),
    cuantas: z.coerce.number().int().min(50).max(1000).optional(),
    minimo: z.coerce.number().int().min(1).max(500).optional().nullable(),
    maximo: z.coerce.number().int().min(5).max(500).optional(),
    excluir: z.string().max(3000, 'La lista de términos a excluir es demasiado larga.').optional(),
    sinonimos: z.string().max(6000, 'La lista de sinónimos es demasiado larga.').optional(),
  })
  .refine((d) => d.origen !== 'openalex' || (d.tema && d.tema.length >= 3), {
    message: 'Escribe el tema que quieres mapear.',
    path: ['tema'],
  })
  .refine((d) => !d.desdeAnio || !d.hastaAnio || d.desdeAnio <= d.hastaAnio, {
    message: 'El año inicial no puede ser posterior al final.',
    path: ['hastaAnio'],
  });

module.exports = { coocurrenciaSchema };
