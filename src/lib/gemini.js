'use strict';

const env = require('../config/env');
const logger = require('../config/logger');
const vectoresGuardados = require('./vectoresGuardados');

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
  json = false,
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
        // Con `json`, Google garantiza que la respuesta sea JSON bien formado.
        // Sin esto, de vez en cuando llegaba con texto alrededor o cortado, y
        // quien lo leía se quedaba sin nada que enseñar.
        ...(json ? { responseMimeType: 'application/json' } : {}),
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
/**
 * Un pico pasajero de Google: saturado (503) o el tope del minuto (429).
 *
 * «This model is currently experiencing high demand. Spikes in demand are
 * usually temporary»: lo dice el propio error. Un tiempo agotado NO cuenta:
 * ese ya se comió sus quince o treinta segundos, y reintentarlo dejaría al
 * tesista mirando la pantalla cargando más de un minuto.
 */
const esPicoPasajero = (error) =>
  error instanceof GeminiError &&
  (error.status === 503 ||
    error.status === 429 ||
    /high demand|overloaded|try again later/i.test(error.message));

/** Lo que se espera entre vuelta y vuelta cuando todos los modelos están en un pico. */
const ESPERAS_TRAS_PICO = [2_000, 4_000];

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

async function generarConRespaldo({ modelos, esperar = dormir, ...opciones }) {
  let ultimoError;

  /**
   * Y si TODOS están en un pico, se espera un poco y se vuelve a probar la lista.
   *
   * Pasar al modelo de respaldo cubre que uno se caiga; no cubre un pico de
   * Google, que tumba a los dos a la vez. El 21-sep-2026 el generador de
   * consultas respondió «la IA no contestó» porque los dos modelos dieron
   * «high demand» en cuatro segundos. Dos vueltas más, con dos y cuatro
   * segundos de espera: como estos errores vuelven en uno o dos segundos, lo
   * peor son unos doce segundos más, y casi siempre sale a la primera espera.
   */
  for (let vuelta = 0; ; vuelta += 1) {
    let todosEnPico = true;

    for (const modelo of modelos) {
      try {
        return { ...(await generar({ ...opciones, modelo })), modelo };
      } catch (error) {
        if (error instanceof GeminiError && error.bloqueado) throw error;
        logger.warn({ modelo, err: error.message }, 'Gemini: el modelo falló, se prueba el siguiente');
        ultimoError = error;
        if (!esPicoPasajero(error)) todosEnPico = false;
      }
    }

    if (!ultimoError || !todosEnPico || vuelta >= ESPERAS_TRAS_PICO.length) break;
    logger.info({ vuelta: vuelta + 1 }, 'Gemini: todos los modelos en un pico, se espera y se reintenta');
    await esperar(ESPERAS_TRAS_PICO[vuelta]);
  }

  throw ultimoError ?? new GeminiError('No hay ningún modelo de Gemini configurado');
}

/**
 * Los vectores que ya se pidieron una vez, para no volver a pagarlos.
 *
 * El vector de un artículo no cambia: mismo título y mismo resumen dan el
 * mismo vector siempre. Y el tope del plan gratuito de Gemini se cuenta por
 * TEXTO, no por petición —cien al minuto—, así que cada artículo que se
 * recuerda es uno que no se gasta. Importa cuando alguien mira un tema, vuelve
 * y prueba el siguiente: los temas hermanos comparten literatura, y la segunda
 * búsqueda se ordena sin pedir casi nada.
 *
 * Vive en el proceso y se pierde al reiniciar, que es justo lo que hace falta:
 * no es un dato del tesista, es el resultado de una cuenta.
 */
const MEMORIA_MAXIMA = 1500;
const memoria = new Map();

const claveDelVector = (modelo, tarea, texto) => `${modelo}\u0000${tarea}\u0000${texto}`;

/** Guarda el vector y, de paso, deja al final el que se acaba de usar. */
function recordarVector(clave, vector) {
  memoria.delete(clave);
  memoria.set(clave, vector);
  // Los primeros del Map son los que llevan más tiempo sin usarse.
  while (memoria.size > MEMORIA_MAXIMA) memoria.delete(memoria.keys().next().value);
}

/**
 * Los vectores de unos textos, para comparar su significado.
 *
 * Los usa la búsqueda semántica de Scopus: la pregunta va con la tarea
 * `RETRIEVAL_QUERY` y los artículos con `RETRIEVAL_DOCUMENT`, que es como
 * Google entrena el modelo para que se encuentren. De cien en cien, que es lo
 * que admite `batchEmbedContents`; 768 dimensiones, que para ordenar sobran.
 *
 * Solo se piden los que no se recuerdan de antes, y se devuelven en el orden
 * en que llegaron: quien llama compara por posición.
 */
async function embeber(
  textos,
  {
    tarea = 'RETRIEVAL_DOCUMENT',
    modelo = env.GEMINI_EMBEDDING_MODEL,
    fetchImpl = fetch,
    // Los vectores de la base. `null` = sin base, para las pruebas que no la tienen.
    guardados = vectoresGuardados,
  } = {},
) {
  const recortados = textos.map((texto) => String(texto).slice(0, 8000));
  const vectores = new Array(recortados.length);
  const pendientes = [];

  const enMemoria = [];
  recortados.forEach((texto, posicion) => {
    const clave = claveDelVector(modelo, tarea, texto);
    const guardado = memoria.get(clave);
    if (guardado) {
      vectores[posicion] = guardado;
      recordarVector(clave, guardado);
    } else {
      enMemoria.push({ texto, posicion });
    }
  });

  /**
   * Lo que no está en memoria, se busca en la base antes de pedírselo a Gemini.
   *
   * La memoria se vacía en cada reinicio y la base no: un artículo que buscó
   * cualquier tesista, cualquier día, ya no gasta cuota. Ver `vectoresGuardados`.
   */
  const deLaBase = guardados
    ? await guardados.leer(enMemoria.map(({ texto }) => guardados.claveDe(modelo, tarea, texto)))
    : new Map();
  for (const pendiente of enMemoria) {
    const vector = guardados ? deLaBase.get(guardados.claveDe(modelo, tarea, pendiente.texto)) : null;
    if (vector) {
      vectores[pendiente.posicion] = vector;
      recordarVector(claveDelVector(modelo, tarea, pendiente.texto), vector);
    } else {
      pendientes.push(pendiente);
    }
  }

  for (let i = 0; i < pendientes.length; i += 100) {
    const lote = pendientes.slice(i, i + 100);
    const url = `${BASE}/models/${encodeURIComponent(modelo)}:batchEmbedContents`;
    const respuesta = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
      body: JSON.stringify({
        requests: lote.map(({ texto }) => ({
          model: `models/${modelo}`,
          content: { parts: [{ text: texto }] },
          taskType: tarea,
          outputDimensionality: 768,
        })),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const cuerpo = await respuesta.json().catch(() => null);
    if (!respuesta.ok || !Array.isArray(cuerpo?.embeddings)) {
      throw new GeminiError(cuerpo?.error?.message ?? `Gemini respondió ${respuesta.status}`, {
        status: respuesta.status,
      });
    }

    const nuevos = [];
    lote.forEach(({ texto, posicion }, n) => {
      const vector = cuerpo.embeddings[n]?.values ?? [];
      vectores[posicion] = vector;
      if (vector.length > 0) {
        recordarVector(claveDelVector(modelo, tarea, texto), vector);
        if (guardados) nuevos.push({ clave: guardados.claveDe(modelo, tarea, texto), modelo, vector });
      }
    });
    // Cada lote que llega se guarda ya: si el siguiente choca con el tope, lo
    // que sí se calculó no se vuelve a pedir.
    if (guardados) await guardados.guardar(nuevos);
  }

  return vectores;
}

/** Vaciar lo recordado. Para las pruebas: cada una empieza sin memoria. */
const olvidarVectores = () => memoria.clear();

module.exports = { generar, generarConRespaldo, embeber, olvidarVectores, GeminiError };
