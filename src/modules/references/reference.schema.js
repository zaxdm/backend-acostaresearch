'use strict';

const { z } = require('zod');

/** Una pasada completa vuelve a traerlo todo, ignorando el marcador. */
const syncBodySchema = z.object({
  completa: z.boolean().optional().default(false),
});

const listQuerySchema = z.object({
  pagina: z.coerce.number().int().positive().max(1000).optional().default(1),
  tamano: z.coerce.number().int().positive().max(100).optional().default(20),
  texto: z.string().trim().max(120).optional().default(''),
});

module.exports = { syncBodySchema, listQuerySchema };
