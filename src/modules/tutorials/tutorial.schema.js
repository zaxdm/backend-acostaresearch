'use strict';

const { z } = require('zod');

/**
 * El identificador de un video de YouTube, venga como venga el enlace.
 *
 * Devuelve null si no hay ninguno, y ese null es el punto: antes se daba por
 * hecho que lo que no encajara ya era un identificador suelto, y así una URL de
 * Studio de 165 caracteres pasó por identificador y produjo un reproductor roto.
 */
function idDeYouTube(enlace) {
  const texto = String(enlace ?? '').trim();

  // Un identificador pelado, tal cual.
  if (/^[\w-]{11}$/.test(texto)) return texto;

  const encontrado = /(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/.exec(texto);
  return encontrado ? encontrado[1] : null;
}

/**
 * Lo que se puede escribir en un tutorial.
 *
 * `videoUrl` acepta vacío a propósito: una tarjeta sin grabar es un estado
 * normal —se escribe el guion antes de grabar— y no un formulario a medio
 * rellenar. La página lo dice en lugar de dejar un hueco negro.
 */
const tutorialBodySchema = z.object({
  orden: z.coerce.number().int().min(0).max(99),
  grupo: z.string().trim().max(60).optional().default(''),
  etiqueta: z.string().trim().max(8, 'La etiqueta es corta: «S4», no una frase.').optional().default(''),
  titulo: z.string().trim().min(3, 'Ponle un título.').max(160),
  duracion: z.string().trim().max(24).optional().default(''),
  entrada: z.string().trim().max(600).optional().default(''),
  /** Un punto por línea. Se guarda tal cual se escribe. */
  puntos: z.string().trim().max(4000).optional().default(''),
  videoUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .default('')
    // Se comprueba aquí y no solo al pintar: la equivocación natural es copiar
    // la URL de la BARRA DEL NAVEGADOR de Studio —que es la página donde uno
    // está— en vez del «Vínculo del video». Sin esta comprobación se guardaba
    // tan ricamente y el fallo aparecía después, como un reproductor en negro
    // con un error de YouTube que no dice nada de lo que pasó.
    .refine((valor) => valor === '' || idDeYouTube(valor) !== null, {
      message:
        'Eso no parece un enlace de YouTube. Copia el del recuadro «Vínculo del video» de ' +
        'Studio (empieza por youtu.be/ o youtube.com/watch), no la dirección de la barra ' +
        'del navegador.',
    }),
  active: z.boolean().optional().default(true),
});

/** Al editar, todo es opcional: se puede cambiar solo la URL del video. */
const tutorialPatchSchema = tutorialBodySchema.partial();

const idParamSchema = z.object({
  id: z.string().uuid('Identificador no válido.'),
});

module.exports = { tutorialBodySchema, tutorialPatchSchema, idParamSchema, idDeYouTube };
