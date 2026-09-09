'use strict';

const { z } = require('zod');

const ESTADOS = ['PENDIENTE', 'EN_CURSO', 'LISTO'];

/**
 * Lo que puede escribir el asistente.
 *
 * Los topes son generosos pero existen, y por una razón concreta: al otro lado
 * hay un modelo de lenguaje al que se le ha pedido «resume lo que quedó
 * decidido». Sin límite, un día manda el capítulo entero, y esto dejaría de ser
 * una memoria para convertirse en un almacén de texto que nadie vuelve a leer.
 *
 * El recorte se hace en el esquema y no en la base para que el aviso llegue al
 * asistente —que puede reintentar más corto— en vez de guardarse a medias.
 */
const guardarAvanceSchema = z.object({
  capitulo: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional(),
  estado: z.enum(ESTADOS).optional(),
  resumen: z
    .string()
    .trim()
    .max(1500, 'El resumen del capítulo no puede pasar de 1500 caracteres. Sé más breve.')
    .optional(),
  tema: z.string().trim().max(500).optional(),
  carrera: z.string().trim().max(160).optional(),
  universidad: z.string().trim().max(160).optional(),
});

/**
 * Cuánto texto de capítulo entra en una sola llamada.
 *
 * El cuerpo de toda petición está limitado a 100 KB en `app.js`, y ese límite
 * protege al servidor de que le manden cualquier cosa. Un capítulo de tesis
 * puede pasar de ahí, así que se manda por partes en vez de abrir el límite: un
 * tope más alto valdría para todo el que llame a la puerta, y esto solo lo
 * necesita el que ya pagó.
 *
 * Treinta mil caracteres son unas cinco mil palabras: un capítulo entero de los
 * normales cabe en una sola llamada, y los largos, en dos o tres.
 */
const MAXIMO_POR_LLAMADA = 30_000;

const guardarCapituloSchema = z.object({
  capitulo: z.string().trim().min(1).max(64),
  texto: z
    .string()
    .min(1, 'No mandaste texto.')
    .max(
      MAXIMO_POR_LLAMADA,
      `Cada envío admite ${MAXIMO_POR_LLAMADA} caracteres. Manda el capítulo por partes: ` +
        'la primera sin «anadir», y las siguientes con «anadir» en verdadero.',
    ),
  /** Verdadero = va detrás de lo que ya había. Falso o ausente = lo reemplaza. */
  anadir: z.boolean().optional(),
});

module.exports = { guardarAvanceSchema, guardarCapituloSchema, ESTADOS, MAXIMO_POR_LLAMADA };
