'use strict';

const { z } = require('zod');

const { IDIOMAS } = require('./preparar.prompt');

/**
 * Lo que se puede pedir hoy.
 *
 * `RESUMEN` se retiró el 22-sep-2026: se quitó de la web y aquí deja de
 * admitirse, así que nadie puede encargarlo ni por la API. Sigue en el enum de
 * la base porque hay trabajos entregados con ese servicio y su historial tiene
 * que poder leerse.
 *
 * `HUMANIZAR` entró el 20-oct-2026 en prueba: el esquema lo admite, y quién
 * puede encargarlo lo decide `preparar.service.puedeHumanizar`.
 */
const SERVICIOS = ['EDICION', 'TRADUCCION', 'HUMANIZAR'];

/**
 * Qué servicio y, si toca, a qué idioma.
 *
 * El idioma se comprueba DOS veces: aquí, contra la lista de los cuatro, y en
 * `preparar.service.idiomaDe`, que además exige que venga cuando el servicio es
 * traducción. Lo segundo no se puede hacer aquí sin volver el esquema difícil
 * de leer, y lo primero no se puede dejar solo allí porque esto es la frontera
 * con el navegador.
 */
const encargoSchema = z.object({
  servicio: z.enum(SERVICIOS, {
    errorMap: () => ({
      message: 'Elige uno de los servicios: edición de inglés, traducción o humanizar.',
    }),
  }),
  idioma: z
    .enum(Object.keys(IDIOMAS), {
      errorMap: () => ({ message: 'Solo traducimos a español, inglés, portugués y chino.' }),
    })
    .nullable()
    .optional(),
  // El reporte de IA subido antes con `POST /reporte-ia` (solo «Humanizar»).
  reporteId: z.string().uuid('Ese reporte no es válido: vuelve a subirlo.').nullable().optional(),
  // Las claves de los títulos de capítulo que no se tocan (solo «Humanizar»), de
  // `POST /capitulos`. En la URL, separadas por comas.
  noTocar: z.array(z.string().regex(/^[\w:.-]{1,40}$/, 'Esos capítulos no son válidos: vuelve a elegirlos.')).max(60).optional(),
});

/** Otra ronda de «Humanizar»: el reporte nuevo, un párrafo, o nada (todo otra vez). */
const rondaSchema = z.object({
  reporteId: z.string().uuid('Ese reporte no es válido: vuelve a subirlo.').nullable().optional(),
  clave: z.string().regex(/^[\w:.-]{1,40}$/, 'Ese párrafo no es válido.').nullable().optional(),
});

module.exports = { encargoSchema, rondaSchema, SERVICIOS };
