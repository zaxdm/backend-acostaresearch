'use strict';

const { z } = require('zod');

const { productosSchema } = require('../../shared/utils/productosDeAyuda');

/** Al subir el PDF la ficha viaja en la query, y ahí la casilla llega como texto. */
const booleano = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

/**
 * Los bloques de la página de guías. Lista cerrada: el panel los ofrece como
 * fichas de una sola elección y no deja escribir variantes. «producto» (21-oct)
 * es la guía de uso de un producto: en el video curso sale en la pestaña de
 * ese producto, y no en «Instalación» ni en «Herramientas».
 */
const GRUPOS_DE_GUIA = Object.freeze(['instalacion', 'herramientas', 'producto']);

/** Lo que se puede escribir en la ficha de una guía. */
const guiaBodySchema = z.object({
  orden: z.coerce.number().int().min(0).max(99).optional().default(1),
  titulo: z.string().trim().min(3, 'Ponle un título.').max(160),
  descripcion: z.string().trim().max(600).optional().default(''),
  /** A qué productos les sirve. En la query llega con comas; vacío = a todos. */
  productos: productosSchema.optional().default(''),
  grupo: z.enum(GRUPOS_DE_GUIA, { message: 'Elige si es de instalación, de herramientas o del producto.' }).optional().default('instalacion'),
  active: booleano.optional().default(true),
});

/** Al editar, todo es opcional. */
const guiaPatchSchema = guiaBodySchema.partial();

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = { GRUPOS_DE_GUIA, guiaBodySchema, guiaPatchSchema, idParamSchema };
