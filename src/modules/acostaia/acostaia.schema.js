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

/** Vincular su compra pegando el enlace del conector (7-nov-2026). */
const vincularEnlaceSchema = z.object({
  acostaiaId,
  enlace: z.string({ required_error: 'Pega el enlace de tu conector.' }).trim().min(20).max(500),
});

/** Buscar sus compras por el correo (verificado) de su cuenta de AcostaIA. */
const buscarVinculoSchema = z.object({
  email: z.string({ required_error: 'Falta el correo.' }).trim().toLowerCase().email().max(255),
});

/** Vincular una de las compras encontradas por correo. */
const vincularCorreoSchema = z.object({
  acostaiaId,
  email: z.string({ required_error: 'Falta el correo.' }).trim().toLowerCase().email().max(255),
  licenseId: z.string({ required_error: 'Falta la licencia.' }).trim().min(8).max(64),
});

/** Desvincular la de un producto. */
const quitarVinculoSchema = z.object({ acostaiaId, productCode });

/**
 * Comprar un método desde Epicuro (7-nov-2026). El correo es el verificado de
 * su cuenta de Epicuro; el importe NO viaja: lo pone el plan.
 */
const correoComprador = z.string({ required_error: 'Falta el correo.' }).trim().toLowerCase().email().max(255);
const ordenCompraSchema = z.object({
  email: correoComprador,
  nombre: z.string().trim().max(80).optional(),
  apellido: z.string().trim().max(80).optional(),
  planCode: z.string({ required_error: 'Falta el plan.' }).trim().min(1).max(60),
  discountCode: z.string().trim().max(40).optional(),
});
const cobrarCompraSchema = z.object({
  email: correoComprador,
  orderId: z.string().trim().min(1).max(120),
  token: z
    .string()
    .trim()
    .regex(/^(tkn|ype)_(test|live)_[A-Za-z0-9]+$/, 'Token de pago no válido.')
    .max(60)
    .optional(),
  deviceFingerprint: z.string().trim().max(100).optional(),
  authentication3DS: z
    .object({
      eci: z.string().trim().max(10).optional(),
      xid: z.string().trim().max(200).optional(),
      cavv: z.string().trim().max(200).optional(),
      protocolVersion: z.string().trim().max(20).optional(),
      directoryServerTransactionId: z.string().trim().max(200).optional(),
    })
    .strict()
    .optional(),
});

module.exports = {
  vincularEnlaceSchema,
  buscarVinculoSchema,
  vincularCorreoSchema,
  quitarVinculoSchema,
  ordenCompraSchema,
  cobrarCompraSchema,
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
