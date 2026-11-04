'use strict';

const { z } = require('zod');

/**
 * El id del usuario en AcostaIA. Lo genera aquel sistema; aquí solo se exige
 * que sea corto y sin caracteres raros, porque va en una columna única.
 */
const acostaiaId = z
  .string({ required_error: 'Falta el id del usuario de AcostaIA.' })
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'El id solo admite letras, números, guion y guion bajo.');

const productCode = z.string({ required_error: 'Falta el producto.' }).trim().toUpperCase().max(40);

/** Alta (o reemplazo) del acceso de un usuario de AcostaIA a un producto. */
const crearAccesoSchema = z.object({
  acostaiaId,
  productCode,
  nombre: z.string().trim().max(80).optional(),
  apellido: z.string().trim().max(80).optional(),
});

/** Corte del acceso: de un producto, o de todos si no se dice cuál. */
const revocarAccesoSchema = z.object({
  acostaiaId,
  productCode: productCode.optional(),
  motivo: z.string().trim().max(200).optional(),
});

module.exports = { crearAccesoSchema, revocarAccesoSchema };
