'use strict';

const env = require('../config/env');
const logger = require('../config/logger');

/**
 * El cliente de Gemini que usa el Asistente Acosta.
 *
 * Sin SDK a propósito: es una sola llamada a `generateContent` y el SDK de
 * Google trae detrás medio ecosistema de dependencias para eso. Node 22 ya
 * tiene `fetch`.
 *
 * Sin clave la función queda apagada, igual que el reescritor sin la de
 * Anthropic: el arranque no se rompe y la web simplemente no enseña el panel.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

if (!env.asistenteEnabled) {
  logger.warn('GEMINI_API_KEY sin configurar: el Asistente Acosta está desactivado');
}

/**
 * Fallo de Gemini.
 *
 * `bloqueado` separa dos cosas que al visitante hay que contarle distinto: que
 * el servicio no contestó —«inténtalo en un momento»— y que contestó negándose
 * por sus filtros, que no se arregla reintentando.
 */
class GeminiError extends Error {
  constructor(message, { status, bloqueado = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.bloqueado = bloqueado;
  }
}

/**
 * Pide una respuesta a un modelo.
 *
 * `mensajes` va en el formato del asistente —`{ rol, texto }`— y aquí se
 * traduce al de Google. `fetchImpl` existe para las pruebas.
 *
 * El razonamiento va al mínimo por defecto: para responder preguntas de una
 * ficha no aporta nada, y medido con estos modelos se comía 190 tokens de
 * pensamiento para una frase de 7.
 */
async function generar({
  sistema,
  mensajes,
  modelo = env.GEMINI_MODEL,
  maxTokens = 900,
  timeoutMs = 20_000,
  fetchImpl = fetch,
}) {
  const url = `${BASE}/models/${encodeURIComponent(modelo)}:generateContent`;

  const respuesta = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: mensajes.map((mensaje) => ({
        role: mensaje.rol === 'asistente' ? 'model' : 'user',
        parts: [{ text: mensaje.texto }],
      })),
      generationConfig: {
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingLevel: env.GEMINI_THINKING },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const cuerpo = await respuesta.json().catch(() => null);

  if (!respuesta.ok) {
    throw new GeminiError(cuerpo?.error?.message ?? `Gemini respondió ${respuesta.status}`, {
      status: respuesta.status,
    });
  }

  if (cuerpo?.promptFeedback?.blockReason) {
    throw new GeminiError(`Pregunta bloqueada: ${cuerpo.promptFeedback.blockReason}`, {
      bloqueado: true,
    });
  }

  const candidato = cuerpo?.candidates?.[0];
  // Las partes de pensamiento llegan marcadas con `thought`: no son respuesta.
  const texto = (candidato?.content?.parts ?? [])
    .filter((parte) => !parte.thought && typeof parte.text === 'string')
    .map((parte) => parte.text)
    .join('')
    .trim();

  if (!texto) {
    const motivo = candidato?.finishReason ?? 'desconocido';
    throw new GeminiError(`Gemini no devolvió texto (${motivo})`, {
      bloqueado: ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION'].includes(motivo),
    });
  }

  return {
    texto,
    finishReason: candidato.finishReason,
    uso: cuerpo.usageMetadata ?? null,
  };
}

/**
 * Prueba los modelos en orden hasta que uno conteste.
 *
 * NO ES UN LUJO. El 13 de septiembre de 2026, probando este asistente,
 * `gemini-3.5-flash` tardaba 25 segundos y devolvía «This model is currently
 * experiencing high demand» a la mitad de las peticiones, mientras el modelo de
 * al lado respondía en dos. Y ese mismo día los `gemini-2.5` ya daban 404: Google
 * los había retirado para clientes nuevos. Con un solo modelo, cualquiera de las
 * dos cosas deja el chat de la web muerto sin que nadie toque nada.
 *
 * Se pasa al siguiente con cualquier fallo MENOS un rechazo por contenido: si un
 * modelo se negó a responder algo, preguntárselo a otro es buscar el que diga
 * que sí.
 */
async function generarConRespaldo({ modelos, ...opciones }) {
  let ultimoError;

  for (const modelo of modelos) {
    try {
      return { ...(await generar({ ...opciones, modelo })), modelo };
    } catch (error) {
      if (error instanceof GeminiError && error.bloqueado) throw error;
      logger.warn({ modelo, err: error.message }, 'Gemini: el modelo falló, se prueba el siguiente');
      ultimoError = error;
    }
  }

  throw ultimoError ?? new GeminiError('No hay ningún modelo de Gemini configurado');
}

module.exports = { generar, generarConRespaldo, GeminiError };
