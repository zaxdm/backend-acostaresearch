'use strict';

const { z } = require('zod');

/**
 * El id de una carpeta de Mendeley es un UUID; el asterisco es «toda la
 * biblioteca». Se valida la forma aunque después se compruebe contra la lista
 * real de sus carpetas: esto rechaza lo que ni parece un id sin gastar una
 * petición, y lo de después impide elegir una carpeta que no es suya.
 */
const elegirCarpetaSchema = z.object({
  clave: z
    .string({ required_error: 'Falta la carpeta.' })
    .trim()
    .regex(/^(\*|[0-9a-fA-F-]{36})$/, 'Esa no es una carpeta de Mendeley.'),
});

/**
 * Lo que trae el navegador al volver de mendeley.com.
 *
 * Todo opcional: si el tesista pulsa «Deny», vuelve con `error` y sin código, y
 * eso no es una petición inválida —es una decisión suya—. El controlador lo
 * lleva al panel diciendo que no autorizó.
 */
const vueltaSchema = z
  .object({
    code: z.string().trim().max(512).optional(),
    state: z.string().trim().max(64).optional(),
    error: z.string().trim().max(200).optional(),
  })
  .passthrough();

module.exports = { elegirCarpetaSchema, vueltaSchema };
