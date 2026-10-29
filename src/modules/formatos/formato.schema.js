'use strict';

const { z } = require('zod');

const { GRADOS } = require('./formato.busqueda');

/** Al subir el .docx la ficha viaja en la query, y ahí la casilla llega como texto. */
const booleano = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

/**
 * Los capítulos de la guía, como los manda el panel. Que las fases existan se
 * comprueba al aplicarlo, contra el catálogo del método (`project.esquema`).
 */
const esquemaSchema = z
  .object({
    capitulos: z
      .array(
        z.object({
          titulo: z.string().trim().min(1, 'Cada capítulo necesita su título.').max(120),
          de: z.array(z.string().trim().min(1).max(64)).max(4).optional(),
        }),
      )
      .max(24),
  })
  .nullable();

/** Lo que se escribe en la ficha de un formato. */
const formatoBodySchema = z.object({
  universidad: z.string().trim().max(160).optional().default(''),
  alias: z.string().trim().max(500).optional().default(''),
  facultad: z.string().trim().max(160).optional().default(''),
  grado: z.enum(GRADOS, { message: 'Elige pregrado, posgrado o cualquiera.' }).optional().default('cualquiera'),
  notas: z.string().trim().max(600).optional().default(''),
  aprobado: booleano.optional(),
});

/** Al editar, todo es opcional, y además se puede poner el esquema. */
const formatoPatchSchema = formatoBodySchema.partial().extend({
  esquema: esquemaSchema.optional(),
  esquemaProducto: z.string().trim().max(40).nullable().optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = { formatoBodySchema, formatoPatchSchema, idParamSchema };
