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

/** «Mis fuentes»: su biblioteca por páginas. */
const fuentesSchema = z.object({
  acostaiaId,
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
  origen: z.enum(['todas', 'zotero', 'mendeley', 'subidas']).default('todas'),
});

/** «Mis documentos»: sus trabajos. */
const documentosSchema = z.object({ acostaiaId });

/** Un enlace de descarga recién firmado. */
const enlaceSchema = z.object({
  acostaiaId,
  productCode,
  que: z.enum(['word', 'documento']).default('word'),
});

/** El permiso para subir su avance. */
const subidaSchema = z.object({ acostaiaId, productCode });

/** Conectores (Zotero y Mendeley). */
const cual = z.enum(['zotero', 'mendeley']);
const conectoresSchema = z.object({ acostaiaId });
const conectorSchema = z.object({ acostaiaId, cual });
const elegirColeccionSchema = z.object({ acostaiaId, cual, clave: z.string().trim().min(1).max(200) });
const irSchema = z.object({ pase: z.string().trim().min(20).max(100) });

module.exports = {
  crearAccesoSchema,
  revocarAccesoSchema,
  fuentesSchema,
  documentosSchema,
  enlaceSchema,
  subidaSchema,
  conectoresSchema,
  conectorSchema,
  elegirColeccionSchema,
  irSchema,
};
