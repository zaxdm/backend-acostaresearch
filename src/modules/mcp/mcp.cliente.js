'use strict';

/**
 * Con qué asistente está hablando el tesista.
 *
 * POR QUÉ HACE FALTA SABERLO
 * --------------------------
 * Los enlaces que reparte el conector —subir el documento, el formato, las
 * entrevistas, los datos de R, descargar el Word— se le dan al asistente ya
 * escritos, y él los copia en la conversación. En claude.ai un enlace en
 * Markdown se enseña como texto que se pulsa, así que se le da hecho:
 * `[Haz clic aquí…](https://…)`, y el tesista no ve el token.
 *
 * En ChatGPT eso NO funciona. Comprobado el 20 de septiembre de 2026 con el
 * conector de informe: al pedirle un enlace, el modelo escribió
 * `https://acostaresearch.com?utm_source=chatgpt.com` —el dominio pelado, sin
 * ruta y sin token—, y el estudiante aterrizaba en la portada sin saber por
 * qué. En el mismo hilo, pedida en texto plano o dentro de un bloque de código,
 * la dirección salía entera y correcta. Es decir: el modelo SÍ tiene la
 * dirección; lo que la rompe es meterla en `[texto](url)`.
 *
 * Como el conector se usa desde Claude, ChatGPT y Grok, la instrucción no puede
 * ser la misma para todos. Y en modo sin estado no vale `clientInfo` del
 * `initialize` —cada petición es un servidor nuevo y `tools/call` llega sin
 * él—, así que se mira la cabecera, que viaja en todas.
 *
 * Lo que se ve en el registro del servidor en la ruta `/mcp/`:
 *
 *   Claude    → `Claude-User`
 *   ChatGPT   → `openai-mcp/1.0.0`
 *
 * Solo se reconoce a ChatGPT, y todo lo demás recibe el trato de siempre. Es a
 * propósito: si mañana OpenAI cambia su cabecera, el conector vuelve al enlace
 * en Markdown, que es lo que funcionaba hasta hoy, en vez de estrenar una forma
 * sin probar en el cliente que sí iba bien.
 */

/** ChatGPT, tanto en el conector como en el modo desarrollador. */
const CHATGPT = /^openai-mcp\//i;

/** `'chatgpt'` u `'otro'`. Sin cabecera, `'otro'`. */
function clienteDe(userAgent) {
  return CHATGPT.test(String(userAgent ?? '').trim()) ? 'chatgpt' : 'otro';
}

module.exports = { clienteDe };
