'use strict';

const { z } = require('zod');

/**
 * Los datos de la ficha viajan por la QUERY, no por el cuerpo: el cuerpo es el
 * .skill en binario. Por eso todo llega como cadena y hay que convertirlo.
 */
const numeroOpcional = z
  .union([z.string(), z.number()])
  .optional()
  .transform((valor) => (valor === undefined || valor === '' ? undefined : Number(valor)))
  .refine((valor) => valor === undefined || Number.isInteger(valor), 'Debe ser un número entero');

const booleanoOpcional = z
  .union([z.enum(['true', 'false']), z.boolean()])
  .optional()
  .transform((valor) => (valor === undefined ? undefined : valor === true || valor === 'true'));

const uploadQuerySchema = z.object({
  displayName: z.string().trim().min(3).max(120).optional(),
  summary: z.string().trim().min(10).max(500).optional(),
  orden: numeroOpcional,
  active: booleanoOpcional,
});

const updateSchema = z
  .object({
    displayName: z.string().trim().min(3).max(120).optional(),
    summary: z.string().trim().min(10).max(500).optional(),
    orden: z.number().int().min(0).optional(),
    active: z.boolean().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, 'No hay nada que cambiar.');

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido'),
});

module.exports = { uploadQuerySchema, updateSchema, idParamSchema };
