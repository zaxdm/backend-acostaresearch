'use strict';

const { z } = require('zod');

/** Al subir el PDF la ficha viaja en la query, y ahí la casilla llega como texto. */
const booleano = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

/** Lo que se puede escribir en la ficha de una guía. */
const guiaBodySchema = z.object({
  orden: z.coerce.number().int().min(0).max(99).optional().default(1),
  titulo: z.string().trim().min(3, 'Ponle un título.').max(160),
  descripcion: z.string().trim().max(600).optional().default(''),
  active: booleano.optional().default(true),
});

/** Al editar, todo es opcional. */
const guiaPatchSchema = guiaBodySchema.partial();

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = { guiaBodySchema, guiaPatchSchema, idParamSchema };
