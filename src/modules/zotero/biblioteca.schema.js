'use strict';

const { z } = require('zod');

/**
 * La clave de una colección de Zotero: ocho caracteres, mayúsculas y dígitos.
 *
 * Se valida la forma aunque después se compruebe contra la lista real de sus
 * colecciones. Las dos cosas: esto rechaza lo que ni siquiera parece una clave
 * sin gastar una petición a Zotero, y la comprobación de después impide que
 * alguien elija una colección que no es suya.
 */
const claveDeColeccion = z
  .string({ required_error: 'Falta la colección.' })
  .trim()
  .regex(/^[A-Z0-9]{8}$/, 'Esa no es una clave de colección de Zotero.');

const elegirColeccionSchema = z.object({ clave: claveDeColeccion });

/**
 * Lo que trae el navegador al volver de zotero.org.
 *
 * `oauth_verifier` es opcional a propósito: si el tesista pulsa «Decline» en la
 * pantalla de Zotero, vuelve con el token y sin verificador. Rechazarlo aquí
 * como petición inválida le daría un error feo por haber hecho algo perfectamente
 * legítimo; el controlador lo lleva de vuelta al panel diciendo que no autorizó.
 */
const vueltaSchema = z
  .object({
    oauth_token: z.string().trim().max(64).optional(),
    oauth_verifier: z.string().trim().max(64).optional(),
  })
  .passthrough();

module.exports = { elegirColeccionSchema, vueltaSchema };
