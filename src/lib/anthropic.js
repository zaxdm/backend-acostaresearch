'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');
const logger = require('../config/logger');

// Sin clave la función queda desactivada; el servicio responde 503 con un código
// claro en lugar de reventar al arrancar.
const client = env.rewriteEnabled
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

if (!env.rewriteEnabled) {
  logger.warn('ANTHROPIC_API_KEY sin configurar: el reescritor está desactivado');
}

/**
 * Tarifas por millón de tokens, en USD. Sirven para estimar el coste de cada
 * reescritura y poder auditar el gasto por usuario.
 * Fuente: precios de la API de Anthropic; revisar si cambian.
 */
const TARIFAS = Object.freeze({
  'claude-opus-5': { entrada: 5, salida: 25, cache: 0.5 },
  'claude-sonnet-5': { entrada: 2, salida: 10, cache: 0.2 },
  'claude-haiku-4-5': { entrada: 1, salida: 5, cache: 0.1 },
});

/** Coste estimado en USD a partir del uso que devuelve la API. */
function estimarCoste(model, usage) {
  const tarifa = TARIFAS[model];
  if (!tarifa) return 0;

  const entrada = (usage.input_tokens ?? 0) / 1_000_000;
  const salida = (usage.output_tokens ?? 0) / 1_000_000;
  const cache = (usage.cache_read_input_tokens ?? 0) / 1_000_000;

  return entrada * tarifa.entrada + salida * tarifa.salida + cache * tarifa.cache;
}

module.exports = { client, Anthropic, estimarCoste, TARIFAS };
