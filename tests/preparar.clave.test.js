'use strict';

/**
 * «Preparar documento» pregunta con SU clave y con un nivel de pensamiento que
 * el modelo acepte.
 *
 * DE DÓNDE SALE ESTA PRUEBA
 * -------------------------
 * Del 23-sep-2026, probando contra la API de verdad:
 *
 *   · La clave de la casa daba 429 —«You exceeded your current quota»— en TODOS
 *     los modelos. La cuota de Google se cuenta por clave, así que el chat de la
 *     web, que es gratis y lo usa cualquiera, se estaba comiendo las peticiones
 *     del documento de quien pagó la membresía.
 *   · `gemini-3.8-flash`, el modelo principal de este servicio, contestaba 400:
 *     «Thinking level MINIMAL is not supported for this model». Y `minimal` es
 *     justo lo que mandaba el código para todo el mundo, porque se eligió
 *     pensando en el chat. Con el nivel quitado, el mismo modelo contesta.
 *     Nadie lo había visto porque el respaldo recogía todas las tandas: el
 *     modelo bueno que se paga a propósito no había traducido nunca una línea.
 *
 * Aquí se comprueba lo que se manda, no cómo responde Google: `fetch` se
 * sustituye.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const gemini = require('../src/lib/gemini');

/** Un `fetch` de mentira que guarda lo que se le pidió y contesta «listo». */
function espia() {
  const peticiones = [];
  const fetchImpl = async (url, opciones) => {
    peticiones.push({ url, cabeceras: opciones.headers, cuerpo: JSON.parse(opciones.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'listo' }] }, finishReason: 'STOP' }],
      }),
    };
  };
  return { peticiones, fetchImpl };
}

const pedir = (extra, fetchImpl) =>
  gemini.generar({
    sistema: 'Traduce.',
    mensajes: [{ rol: 'usuario', texto: '{"1":"Hola."}' }],
    modelo: 'gemini-3.8-flash',
    fetchImpl,
    ...extra,
  });

// ── La clave ───────────────────────────────────────────────────────────────

test('se pregunta con la clave que se le pasa, no con la de la casa', async () => {
  const { peticiones, fetchImpl } = espia();

  await pedir({ clave: 'la-del-traductor' }, fetchImpl);

  assert.equal(peticiones[0].cabeceras['x-goog-api-key'], 'la-del-traductor');
});

test('sin clave propia se sigue usando la de la casa', async () => {
  const { peticiones, fetchImpl } = espia();
  const env = require('../src/config/env');

  await pedir({}, fetchImpl);

  assert.equal(peticiones[0].cabeceras['x-goog-api-key'], env.GEMINI_API_KEY ?? '');
});

// ── El nivel de pensamiento ────────────────────────────────────────────────

test('con «auto» no se manda ningún nivel: lo decide el modelo', async () => {
  const { peticiones, fetchImpl } = espia();

  await pedir({ thinking: 'auto' }, fetchImpl);

  assert.equal(peticiones[0].cuerpo.generationConfig.thinkingConfig, undefined);
});

test('con un nivel concreto sí se manda', async () => {
  const { peticiones, fetchImpl } = espia();

  await pedir({ thinking: 'low' }, fetchImpl);

  assert.deepEqual(peticiones[0].cuerpo.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

// ── La escalera de respaldos ───────────────────────────────────────────────

test('el respaldo admite varios modelos, en orden y sin repetir', () => {
  // En otro proceso: la configuración se lee una vez al arrancar y se congela,
  // que es justo lo que se quiere comprobar aquí.
  const { execFileSync } = require('node:child_process');

  const salida = execFileSync(
    process.execPath,
    ['-e', "console.log(JSON.stringify(require('./src/modules/preparar/preparar.motor').modelos()))"],
    {
      cwd: require('node:path').join(__dirname, '..'),
      env: {
        ...process.env,
        PREPARAR_MODELO: 'gemini-3.8-flash',
        PREPARAR_MODELO_RESPALDO: ' gemini-3.5-flash, groq:openai/gpt-oss-120b ,gemini-3.8-flash',
      },
      encoding: 'utf8',
    },
  );

  // El principal primero, los respaldos en su orden, y el repetido una sola vez.
  assert.deepEqual(JSON.parse(salida.trim().split('\n').at(-1)), [
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'groq:openai/gpt-oss-120b',
  ]);
});

// ── Lo que de verdad manda el traductor ────────────────────────────────────

test('el motor del traductor manda su clave y su nivel, no los del chat', async () => {
  const env = require('../src/config/env');
  const motor = require('../src/modules/preparar/preparar.motor');

  const visto = [];
  const generar = async (peticion) => {
    visto.push(peticion);
    return { texto: JSON.stringify({ 1: 'Hello.' }) };
  };

  await motor.prepararParrafos({
    parrafos: [{ clave: '1', id: 1, texto: 'Hola.', palabras: 1 }],
    servicio: 'TRADUCCION',
    idioma: 'en',
    generar,
  });

  assert.equal(visto.length, 1);
  assert.equal(visto[0].clave, env.PREPARAR_GEMINI_API_KEY || env.GEMINI_API_KEY);
  assert.equal(visto[0].thinking, env.PREPARAR_THINKING);

  // Y el nivel por defecto es el que acepta gemini-3.8-flash, que es el motivo
  // de todo esto: `minimal` le devuelve un 400 y no traduce nada.
  assert.equal(env.PREPARAR_THINKING, 'auto');
});
