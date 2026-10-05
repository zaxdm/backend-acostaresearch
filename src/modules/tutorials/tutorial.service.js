'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const prisma = require('../../lib/prisma');
const { AppError, ConflictError, NotFoundError } = require('../../shared/errors/AppError');

/**
 * Lo que se le pide a Gemini al ver el video. Corto y en segunda persona,
 * como el resto de la página de tutoriales.
 */
const PEDIDO_RESUMEN =
  'Eres el editor de la página de tutoriales de Acosta | IA & Research, que enseña a ' +
  'tesistas a hacer su tesis con Claude y Skills. Mira el video y devuelve SOLO un JSON ' +
  '{"entrada": "...", "puntos": ["...", "..."]}. "entrada": una o dos frases en español, ' +
  'de tú, que digan de qué va el video y para qué le sirve al tesista (máximo 300 ' +
  'caracteres). "puntos": de 4 a 6 cosas concretas que se ven en el video, en el orden ' +
  'en que aparecen, cada una en una frase corta sin punto final. Solo lo que de verdad ' +
  'sale en el video: no inventes pasos.';

/**
 * Los videos de la página de tutoriales.
 *
 * Los puntos se guardan como texto con un salto de línea por punto —así se
 * escriben en el panel— y salen como lista, que es como los pinta la página.
 * La conversión vive aquí y en un solo sitio: ni el panel ni la web tienen que
 * saber cómo están guardados.
 */

const aLista = (texto) =>
  String(texto ?? '')
    .split('\n')
    .map((linea) => linea.trim())
    .filter(Boolean);

const salida = (fila) => ({ ...fila, puntos: aLista(fila.puntos) });

const tutorialService = {
  /** Lo que ve el visitante: solo lo activo, en su orden. */
  async listPublic() {
    const filas = await prisma.tutorial.findMany({
      where: { active: true },
      orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map(salida);
  },

  /** Lo que ve el panel: todo, incluido lo apagado. */
  async listAll() {
    const filas = await prisma.tutorial.findMany({
      orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }],
    });
    return filas.map(salida);
  },

  async create(datos) {
    const fila = await prisma.tutorial.create({ data: datos });
    return salida(fila);
  },

  async update(id, datos) {
    const existe = await prisma.tutorial.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Ese tutorial no existe.');

    const fila = await prisma.tutorial.update({ where: { id }, data: datos });
    return salida(fila);
  },

  /**
   * Renumera 1, 2, 3… según el orden de `ids`.
   *
   * Tiene que venir la lista completa: si faltara uno, quedaría con su número
   * viejo y chocaría con el de otro. En una transacción, para que un fallo a
   * medias no deje dos videos con el mismo número.
   */
  async reorder(ids) {
    const existentes = await prisma.tutorial.findMany({ select: { id: true } });
    const conocidos = new Set(existentes.map((fila) => fila.id));
    const completa =
      new Set(ids).size === ids.length &&
      ids.length === conocidos.size &&
      ids.every((id) => conocidos.has(id));
    if (!completa) {
      throw new ConflictError('La lista cambió mientras la ordenabas. Recarga y vuelve a intentarlo.');
    }

    await prisma.$transaction(
      ids.map((id, i) => prisma.tutorial.update({ where: { id }, data: { orden: i + 1 } })),
    );
    return tutorialService.listAll();
  },

  /**
   * El título de un video por oEmbed, que es público y no pide clave.
   *
   * Solo el título: la duración no viene en oEmbed, y la página del video al
   * servidor le pide iniciar sesión. La duración la lee el panel con el
   * reproductor incrustado (`youtube-datos.ts` en la web). Null si YouTube no
   * contesta o el video es privado: el título se escribe a mano.
   */
  async datosDeYouTube(videoId) {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}`;
    try {
      const respuesta = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!respuesta.ok) return { titulo: null };
      const datos = await respuesta.json();
      const titulo = typeof datos.title === 'string' ? datos.title.trim().slice(0, 160) : '';
      return { titulo: titulo || null };
    } catch {
      return { titulo: null };
    }
  },

  /**
   * «De qué va» y «Puntos que cubre», escritos por Gemini viendo el video.
   *
   * Gemini acepta un enlace de YouTube como si fuera un archivo y ve el video
   * entero (vídeo y audio). Solo funciona con videos PÚBLICOS: uno oculto o
   * privado da error y el panel lo dice. Resolución baja y un fotograma cada
   * 10 s: lo que se explica va en el audio, y así gasta mucho menos. Solo se
   * llama cuando el admin pulsa «Escribir con IA», nunca al pegar el enlace.
   * Si el modelo principal está saturado, se prueba el de respaldo.
   */
  async resumenDeYouTube(videoId) {
    if (!env.GEMINI_API_KEY) {
      throw new AppError('La IA no está configurada en el servidor.', { statusCode: 503 });
    }
    const modelos = [env.GEMINI_MODEL, env.GEMINI_MODEL_RESPALDO].filter(
      (modelo, i, lista) => modelo && lista.indexOf(modelo) === i,
    );

    for (const modelo of modelos) {
      try {
        const respuesta = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` },
                      // Un fotograma cada 10 s en vez de uno por segundo: es una
                      // grabación de pantalla con voz, lo que cuenta va en el audio.
                      videoMetadata: { fps: 0.1 },
                    },
                    { text: PEDIDO_RESUMEN },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 1500,
                mediaResolution: 'MEDIA_RESOLUTION_LOW',
              },
            }),
            signal: AbortSignal.timeout(90_000),
          },
        );
        const cuerpo = await respuesta.json().catch(() => null);
        if (!respuesta.ok) {
          logger.warn({ modelo, status: respuesta.status, error: cuerpo?.error?.message }, 'Resumen de video: Gemini falló');
          continue;
        }
        const texto = (cuerpo?.candidates?.[0]?.content?.parts ?? [])
          .filter((parte) => !parte.thought && typeof parte.text === 'string')
          .map((parte) => parte.text)
          .join('');
        const datos = JSON.parse(texto);
        const entrada = String(datos?.entrada ?? '').trim().slice(0, 600);
        const puntos = (Array.isArray(datos?.puntos) ? datos.puntos : [])
          .map((punto) => String(punto).trim())
          .filter(Boolean)
          .slice(0, 8);
        if (entrada || puntos.length > 0) return { entrada, puntos };
      } catch (error) {
        logger.warn({ modelo, err: error?.message }, 'Resumen de video: respuesta no válida');
      }
    }

    throw new AppError(
      'La IA no pudo ver el video ahora. Si es oculto o privado no puede; si es público, ' +
        'prueba otra vez en un rato o escríbelo a mano.',
      { statusCode: 503 },
    );
  },

  async remove(id) {
    const existe = await prisma.tutorial.findUnique({ where: { id }, select: { id: true } });
    if (!existe) throw new NotFoundError('Ese tutorial no existe.');

    await prisma.tutorial.delete({ where: { id } });
    return { id };
  },
};

module.exports = tutorialService;
