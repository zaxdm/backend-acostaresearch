'use strict';

const { z } = require('zod');

/** Mensajes por conversación. A partir de aquí se pide empezar otra. */
const MAX_MENSAJES = 30;

/** Lo que puede escribir el visitante en un mensaje. */
const MAX_CARACTERES_USUARIO = 800;

const mensajeSchema = z.object({
  rol: z.enum(['usuario', 'asistente']),
  // El techo de las respuestas del asistente es más alto: las devuelve el
  // propio servidor, pero viajan de vuelta desde el navegador y hay que poner
  // un límite a lo que se acepta.
  texto: z.string().trim().min(1, 'Escribe tu pregunta.').max(4000),
});

/**
 * Una conversación entera, tal como la guarda el navegador.
 *
 * No se guarda en el servidor —ni en la base ni en disco—: la historia viaja
 * completa en cada mensaje y se olvida al responder. Por eso se valida tanto,
 * porque no hay otra copia con la que contrastarla.
 */
const conversacionSchema = z.object({
  mensajes: z
    .array(mensajeSchema)
    .min(1, 'Escribe tu pregunta.')
    .max(MAX_MENSAJES, 'La conversación ya es larga. Empieza una nueva para seguir.')
    .refine(
      (mensajes) => mensajes.every((m) => m.rol !== 'usuario' || m.texto.length <= MAX_CARACTERES_USUARIO),
      `Tu mensaje es muy largo: resúmelo en menos de ${MAX_CARACTERES_USUARIO} caracteres.`,
    )
    // Gemini exige turnos alternos y que empiece quien pregunta. Una historia
    // manipulada que no lo cumpla daría un error suyo sin explicación.
    .refine(
      (mensajes) =>
        mensajes.length > 0 &&
        mensajes.every((m, i) => m.rol === (i % 2 === 0 ? 'usuario' : 'asistente')) &&
        mensajes.at(-1).rol === 'usuario',
      'La conversación llegó desordenada. Empieza una nueva.',
    ),
  // Solo la ruta, sin consulta: acaba dentro de las instrucciones del modelo, así
  // que no se admite nada que no sea un camino de la web.
  pagina: z
    .string()
    .trim()
    .max(200)
    .regex(/^\/[\w\-/]*$/, 'Página no válida.')
    .optional(),
  conSesion: z.boolean().optional().default(false),
});

module.exports = { conversacionSchema, MAX_MENSAJES, MAX_CARACTERES_USUARIO };
