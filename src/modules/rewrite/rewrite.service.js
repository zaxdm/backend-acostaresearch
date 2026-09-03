'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const { client, Anthropic, estimarCoste } = require('../../lib/anthropic');
const rewriteRepository = require('./rewrite.repository');
const billingService = require('../billing/billing.service');
const { SYSTEM_PROMPT, buildUserMessage } = require('./rewrite.prompt');
const { AppError } = require('../../shared/errors/AppError');

/** Cuenta palabras de forma tolerante con la puntuación y los saltos de línea. */
function contarPalabras(texto) {
  const limpio = texto.trim();
  return limpio ? limpio.split(/\s+/).length : 0;
}

/**
 * Techo de salida. La reescritura ocupa aproximadamente lo mismo que el
 * original, pero se deja margen porque el razonamiento también consume tokens
 * de salida; quedarse corto trunca el texto a media frase.
 */
function techoDeSalida(palabras) {
  const estimado = Math.ceil(palabras * 2.5) + 4000;
  return Math.min(Math.max(estimado, 4000), 64000);
}

const rewriteService = {
  list(userId, opciones) {
    return rewriteRepository.paginateForUser(userId, opciones);
  },

  async get(id, userId) {
    const rewrite = await rewriteRepository.findForUser(id, userId);
    if (!rewrite) {
      throw new AppError('No encontramos esa reescritura.', {
        statusCode: 404,
        code: ERROR_CODES.NOT_FOUND,
      });
    }
    return rewrite;
  },

  /**
   * Reescribe el texto del usuario. El saldo se comprueba ANTES de llamar al
   * modelo, porque una vez enviada la petición el coste ya está incurrido.
   */
  async rewrite({ userId, text, mode, chapter }) {
    // Primero lo que depende de la petición: son errores del usuario que
    // seguirán ahí aunque el servicio vuelva, y merecen un mensaje concreto.
    const palabras = contarPalabras(text);

    if (palabras > env.REWRITE_MAX_WORDS_PER_REQUEST) {
      throw new AppError(
        `El texto supera el máximo de ${env.REWRITE_MAX_WORDS_PER_REQUEST} palabras por envío. ` +
          'Divídelo por secciones y reescríbelo por partes.',
        { statusCode: 413, code: ERROR_CODES.TEXT_TOO_LONG, details: { words: palabras } },
      );
    }

    await billingService.assertBalance(userId, palabras);

    // La disponibilidad se comprueba al final: es lo único que puede cambiar
    // sin que el usuario toque nada.
    if (!client) {
      throw new AppError('El reescritor no está disponible en este momento.', {
        statusCode: 503,
        code: ERROR_CODES.REWRITE_UNAVAILABLE,
      });
    }

    const inicio = Date.now();

    try {
      // Se usa streaming aunque no se retransmita al navegador: con textos largos
      // una petición sin stream puede agotar el tiempo de espera HTTP.
      const stream = client.messages.stream({
        model: env.REWRITE_MODEL,
        max_tokens: techoDeSalida(palabras),
        // El prompt es idéntico en todas las peticiones: cachearlo evita pagar
        // sus tokens una y otra vez.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        thinking: { type: 'adaptive' },
        output_config: { effort: env.REWRITE_EFFORT },
        messages: [{ role: 'user', content: buildUserMessage({ text, mode, chapter }) }],
      });

      const respuesta = await stream.finalMessage();

      // Los clasificadores de seguridad pueden declinar: hay que mirar stop_reason
      // ANTES de leer el contenido, o se devolvería una respuesta vacía.
      if (respuesta.stop_reason === 'refusal') {
        logger.warn(
          { userId, categoria: respuesta.stop_details?.category },
          'El modelo declinó la reescritura',
        );
        throw new AppError('No pudimos procesar este texto. Revísalo e inténtalo de nuevo.', {
          statusCode: 422,
          code: ERROR_CODES.REWRITE_REFUSED,
        });
      }

      const resultado = respuesta.content
        .filter((bloque) => bloque.type === 'text')
        .map((bloque) => bloque.text)
        .join('')
        .trim();

      if (!resultado) {
        throw new AppError('El reescritor devolvió una respuesta vacía. Inténtalo de nuevo.', {
          statusCode: 502,
          code: ERROR_CODES.REWRITE_FAILED,
        });
      }

      const uso = respuesta.usage;
      const registro = await rewriteRepository.create({
        userId,
        mode,
        chapter,
        status: 'COMPLETED',
        sourceText: text,
        resultText: resultado,
        sourceWords: palabras,
        model: respuesta.model,
        inputTokens: uso.input_tokens ?? 0,
        outputTokens: uso.output_tokens ?? 0,
        cachedTokens: uso.cache_read_input_tokens ?? 0,
        costUsd: estimarCoste(respuesta.model, uso),
        durationMs: Date.now() - inicio,
      });

      // El saldo se descuenta DESPUÉS de que el modelo respondiera bien: si falla,
      // el usuario no pierde palabras.
      await billingService.consumeWords(userId, palabras);

      logger.info(
        {
          userId,
          rewriteId: registro.id,
          palabras,
          entrada: uso.input_tokens,
          salida: uso.output_tokens,
          cacheados: uso.cache_read_input_tokens,
          costeUsd: Number(estimarCoste(respuesta.model, uso).toFixed(5)),
          ms: registro.durationMs,
        },
        'Reescritura completada',
      );

      return registro;
    } catch (error) {
      const codigo = this.traducirError(error);

      // Queda constancia del intento fallido. No se descuenta saldo: el consumo
      // solo ocurre en la rama de éxito.
      await rewriteRepository
        .create({
          userId,
          mode,
          chapter,
          status: 'FAILED',
          sourceText: text,
          sourceWords: palabras,
          model: env.REWRITE_MODEL,
          errorCode: codigo.code,
          durationMs: Date.now() - inicio,
        })
        .catch((errorBd) => logger.error({ err: errorBd }, 'No se pudo registrar el fallo'));

      throw codigo;
    }
  },

  /** Convierte los errores del SDK en errores de la API con mensaje útil. */
  traducirError(error) {
    if (error instanceof AppError) return error;

    if (error instanceof Anthropic.RateLimitError) {
      logger.warn({ err: error }, 'Límite de la API de Anthropic alcanzado');
      return new AppError('El servicio está saturado. Prueba de nuevo en un minuto.', {
        statusCode: 429,
        code: ERROR_CODES.TOO_MANY_REQUESTS,
      });
    }

    if (error instanceof Anthropic.AuthenticationError) {
      // Problema de configuración nuestro, no del usuario.
      logger.error({ err: error }, 'Credencial de Anthropic inválida');
      return new AppError('El reescritor no está disponible en este momento.', {
        statusCode: 503,
        code: ERROR_CODES.REWRITE_UNAVAILABLE,
      });
    }

    if (error instanceof Anthropic.APIError) {
      logger.error({ err: error, status: error.status }, 'Error de la API de Anthropic');
      return new AppError('No pudimos completar la reescritura. Inténtalo de nuevo.', {
        statusCode: 502,
        code: ERROR_CODES.REWRITE_FAILED,
      });
    }

    logger.error({ err: error }, 'Fallo inesperado en la reescritura');
    return new AppError('No pudimos completar la reescritura. Inténtalo de nuevo.', {
      statusCode: 500,
      code: ERROR_CODES.REWRITE_FAILED,
    });
  },
};

module.exports = rewriteService;
