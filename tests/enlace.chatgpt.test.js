'use strict';

/**
 * El enlace, en la forma que entiende cada asistente.
 *
 * El 20 de septiembre de 2026 se probó el conector desde ChatGPT y no había
 * manera de subir nada: al pedir el enlace del material del curso, el modelo
 * escribía `https://acostaresearch.com?utm_source=chatgpt.com` —el dominio
 * pelado— y el estudiante aterrizaba en la portada. En el mismo hilo, pedida en
 * texto plano, la dirección salía entera. Lo que la rompía era el Markdown.
 *
 * Estas pruebas fijan las dos cosas que no pueden volver a cruzarse: que a
 * ChatGPT NO se le pide un enlace en Markdown, y que a los demás se les sigue
 * dando como estaba, que ahí funcionaba.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { clienteDe } = require('../src/modules/mcp/mcp.cliente');
const { enlaceClic } = require('../src/shared/utils/enlaceClic');

const URL_LARGA = 'https://acostaresearch.com/subir-material/eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJ4In0.abc-_123';

test('ChatGPT se reconoce por su cabecera, y los demás reciben el trato de siempre', () => {
  assert.equal(clienteDe('openai-mcp/1.0.0'), 'chatgpt');
  assert.equal(clienteDe('openai-mcp/1.0'), 'chatgpt');
  // Como llega Claude en la ruta del conector.
  assert.equal(clienteDe('Claude-User'), 'otro');
  assert.equal(clienteDe(undefined), 'otro');
  assert.equal(clienteDe(''), 'otro');
  // Que la cadena contenga el nombre no basta: tiene que empezar por él.
  assert.equal(clienteDe('Mozilla/5.0 (openai-mcp/1.0.0)'), 'otro');
});

test('a ChatGPT se le da la dirección entera y se le prohíbe convertirla en enlace', () => {
  const linea = enlaceClic({ texto: 'Haz clic aquí para subir tu documento', url: URL_LARGA, minutos: 30, cliente: 'chatgpt' });

  // La dirección, sola en su línea y sin tocar: es lo único que sobrevive.
  const lineas = linea.split('\n');
  assert.equal(lineas[1], URL_LARGA);
  assert.ok(!linea.includes(`](${URL_LARGA})`), 'a ChatGPT no se le pide Markdown');
  assert.match(linea, /NO la escribas como enlace con un texto encima/);
  // El bloque de código la dejaba entera pero obligaba a copiarla a mano.
  assert.match(linea, /NO la metas en un bloque de código/);
  assert.match(linea, /COMO TEXTO NORMAL/);
  assert.match(linea, /No la acortes ni escribas solo el dominio/);
  assert.match(linea, /30 minutos/);
  assert.match(linea, /NUNCA repitas/);
});

test('a los demás se les sigue dando el enlace en Markdown, sin enseñar la dirección', () => {
  const linea = enlaceClic({ texto: 'Haz clic aquí para subir tu documento', url: URL_LARGA, minutos: 30, cliente: 'otro' });
  const [enlace, instruccion] = linea.split('\n');

  assert.equal(enlace, `[Haz clic aquí para subir tu documento](${URL_LARGA})`);
  assert.match(instruccion, /NO escribas la dirección/);
  assert.match(instruccion, /no la pongas en un bloque de código/);
});

test('sin decir con quién se habla, se comporta como antes de este cambio', () => {
  const sinCliente = enlaceClic({ texto: 'Haz clic aquí', url: URL_LARGA, minutos: 30 });
  const comoOtro = enlaceClic({ texto: 'Haz clic aquí', url: URL_LARGA, minutos: 30, cliente: 'otro' });
  assert.equal(sinCliente, comoOtro);
});

test('las dos formas dicen cuánto dura, y sin minutos ninguna lo menciona', () => {
  for (const cliente of ['chatgpt', 'otro']) {
    const conMinutos = enlaceClic({ texto: 'Haz clic aquí', url: URL_LARGA, minutos: 30, cliente });
    assert.match(conMinutos, /Caduca en 30 minutos/);

    const sinMinutos = enlaceClic({ texto: 'Haz clic aquí', url: URL_LARGA, cliente });
    assert.ok(!sinMinutos.includes('Caduca'), `${cliente}: sin minutos no se inventa una caducidad`);
  }
});
