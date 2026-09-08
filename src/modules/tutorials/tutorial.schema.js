'use strict';

const { z } = require('zod');

/**
 * Lo que se puede escribir en un tutorial.
 *
 * `videoUrl` acepta vacío a propósito: una tarjeta sin grabar es un estado
 * normal —se escribe el guion antes de grabar— y no un formulario a medio
 * rellenar. La página lo dice en lugar de dejar un hueco negro.
 */
const tutorialBodySchema = z.object({
  orden: z.coerce.number().int().min(0).max(99),
  titulo: z.string().trim().min(3, 'Ponle un título.').max(160),
  duracion: z.string().trim().max(24).optional().default(''),
  entrada: z.string().trim().max(600).optional().default(''),
  /** Un punto por línea. Se guarda tal cual se escribe. */
  puntos: z.string().trim().max(4000).optional().default(''),
  videoUrl: z.string().trim().max(500).optional().default(''),
  active: z.boolean().optional().default(true),
});

/** Al editar, todo es opcional: se puede cambiar solo la URL del video. */
const tutorialPatchSchema = tutorialBodySchema.partial();

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = { tutorialBodySchema, tutorialPatchSchema, idParamSchema };
