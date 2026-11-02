'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Claude por la API de Anthropic, con la clave del humanizador (2-nov-2026).
 *
 * En su propio archivo porque `env` se congela al cargarse: la clave tiene que
 * estar puesta antes. Lo que duele si se rompe: que use la clave equivocada (la
 * del reescritor), que reintente por su cuenta, o que un fallo no deje pasar al
 * siguiente modelo de la lista.
 */

process.env.ANTHROPIC_API_KEY_HUMANIZADOR = 'sk-ant-humanizador';
delete process.env.ANTHROPIC_API_KEY;

const { generarConRespaldo, olvidarReposos } = require('../src/lib/gemini');

const unaPregunta = { sistema: 's', mensajes: [{ rol: 'usuario', texto: 'hola' }] };

const RESPUESTA = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: '```json\n{"1":"listo"}\n```' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 120, output_tokens: 30 },
};

/** Un `fetch` que apunta lo que le pidieron y contesta lo que se le diga. */
const espia = (respuestas) => {
  const pedidos = [];
  const fetchImpl = async (url, init) => {
    const cabeceras = new Headers(init.headers);
    pedidos.push({ url: String(url), headers: cabeceras, cuerpo: JSON.parse(init.body) });
    const [status, cuerpo, extra] = respuestas[Math.min(pedidos.length - 1, respuestas.length - 1)];
    return new Response(JSON.stringify(cuerpo), {
      status,
      headers: { 'content-type': 'application/json', ...(extra ?? {}) },
    });
  };
  return { pedidos, fetchImpl };
};

test('anthropic:<modelo> va a la API de Anthropic con la clave del humanizador', async () => {
  olvidarReposos();
  const { pedidos, fetchImpl } = espia([[200, RESPUESTA]]);

  const { texto, uso, modelo } = await generarConRespaldo({
    modelos: ['anthropic:claude-sonnet-5-5'],
    ...unaPregunta,
    json: true,
    maxTokens: 4_000,
    fetchImpl,
  });

  assert.equal(pedidos.length, 1);
  assert.ok(pedidos[0].url.startsWith('https://api.anthropic.com/v1/messages'), pedidos[0].url);
  assert.equal(pedidos[0].headers.get('x-api-key'), 'sk-ant-humanizador');
  assert.equal(pedidos[0].cuerpo.model, 'claude-sonnet-5-5', 'al proveedor se le manda sin el prefijo');
  assert.equal(pedidos[0].cuerpo.system, 's');
  assert.equal(pedidos[0].cuerpo.output_config.effort, 'low');
  assert.ok(pedidos[0].cuerpo.max_tokens > 4_000, 'con margen para lo que piensa');
  assert.equal(modelo, 'anthropic:claude-sonnet-5-5');
  assert.equal(texto, '{"1":"listo"}', 'sin el envoltorio ```json');
  assert.equal(uso.promptTokenCount, 120);
  assert.equal(uso.candidatesTokenCount, 30);
});

test('si Anthropic falla, la carrera pasa al siguiente sin reintentar dentro del SDK', async () => {
  olvidarReposos();
  const pedidosGemini = [];
  const { pedidos, fetchImpl: aAnthropic } = espia([
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }],
  ]);
  const fetchImpl = async (url, init) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      pedidosGemini.push(url);
      return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'gemini' }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return aAnthropic(url, init);
  };

  const { texto, modelo } = await generarConRespaldo({
    modelos: ['anthropic:claude-sonnet-5-5', 'gemini-3.5-flash'],
    ...unaPregunta,
    fetchImpl,
  });

  assert.equal(pedidos.length, 1, 'el SDK no reintenta por su cuenta');
  assert.equal(pedidosGemini.length, 1);
  assert.equal(modelo, 'gemini-3.5-flash');
  assert.equal(texto, 'gemini');
});

test('un 429 de Anthropic llega con su status y la espera que pide', async () => {
  olvidarReposos();
  const { generarEnAnthropic } = require('../src/lib/gemini');
  const { fetchImpl } = espia([
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, { 'retry-after': '12' }],
  ]);

  await assert.rejects(
    generarEnAnthropic({ ...unaPregunta, modelo: 'claude-sonnet-5-5', fetchImpl }),
    (error) => error.name === 'GeminiError' && error.status === 429 && error.esperarMs === 12_000,
  );
});
