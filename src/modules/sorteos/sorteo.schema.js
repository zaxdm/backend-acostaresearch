'use strict';

const { z } = require('zod');

/**
 * Lo que entra en los sorteos.
 *
 * El correo NO se verifica —ni código por correo ni consulta al buzón—: lo
 * pidió así el administrador, para que apuntarse cueste un solo paso. Solo se
 * mira que tenga forma de correo, porque uno sin arroba no puede recibir el
 * premio y ensuciaría la ruleta.
 */

const slugParamSchema = z.object({
  slug: z.string().trim().min(4).max(40),
});

const idParamSchema = z.object({
  id: z.string().uuid('Ese sorteo no existe.'),
});

const participanteParamSchema = z.object({
  id: z.string().uuid('Ese sorteo no existe.'),
  participanteId: z.string().uuid('Ese inscrito no existe.'),
});

const inscripcionSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(255, 'El correo es demasiado largo.')
    .email('Escribe un correo válido.'),
  nombre: z.string().trim().max(120, 'Como mucho 120 caracteres.').optional().default(''),
});

const crearSchema = z.object({
  nombre: z
    .string()
    .trim()
    .min(3, 'Ponle un nombre al sorteo.')
    .max(120, 'Como mucho 120 caracteres.'),
});

const cambiarSchema = z.object({
  abierto: z.boolean(),
});

module.exports = {
  slugParamSchema,
  idParamSchema,
  participanteParamSchema,
  inscripcionSchema,
  crearSchema,
  cambiarSchema,
};
