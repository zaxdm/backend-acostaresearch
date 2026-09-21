'use strict';

/**
 * El generador de consultas con IA del buscador de Scopus.
 *
 * Lo que devuelve Gemini acaba dentro de una ecuación de Scopus. Tres cosas
 * tienen que ser ciertas pase lo que pase con el modelo:
 *
 *   · Ningún término lleva paréntesis, comillas ni operadores: romperían la
 *     ecuación o cambiarían lo que se busca.
 *   · Hay techo de conceptos y de sinónimos, y nada repetido.
 *   · Un fallo de Gemini es un 503 con ASSISTANT_UNAVAILABLE, nunca
 *     SERVICE_UNAVAILABLE, que encendería la pantalla de mantenimiento.
 *
 * Gemini se sustituye: lo que se comprueba es qué se hace con su respuesta.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const env = {
  asistenteEnabled: true,
  scopusApiEnabled: true,
  GEMINI_MODEL: 'modelo-a',
  GEMINI_MODEL_RESPALDO: 'modelo-b',
};
sustituir('../src/config/env', env);
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { generarConsulta, normalizar } = require('../src/modules/scopus/scopus.consulta');
const { GeminiError } = require('../src/lib/gemini');

const contesta = (texto) => async () => ({ texto });

test('los términos llegan limpios: sin paréntesis, comillas ni operadores', () => {
  const { conceptos } = normalizar({
    conceptos: [
      { nombre: '"critical thinking"', sinonimos: ['(critical reasoning)', 'AI OR ChatGPT'] },
    ],
  });

  assert.equal(conceptos[0].nombre, 'critical thinking');
  assert.deepEqual(conceptos[0].sinonimos, ['critical reasoning', 'AI ChatGPT']);
});

test('techo de conceptos y de sinónimos, y nada repetido', () => {
  const muchos = Array.from({ length: 9 }, (_, i) => ({
    nombre: `concepto ${i}`,
    sinonimos: Array.from({ length: 9 }, (_, j) => `sinonimo ${i}-${j}`),
  }));
  const { conceptos } = normalizar({ conceptos: muchos });

  assert.equal(conceptos.length, 5);
  assert.ok(conceptos.every((c) => c.sinonimos.length <= 5));

  const repetidos = normalizar({
    conceptos: [
      { nombre: 'ChatGPT', sinonimos: ['chatgpt', 'GPT-4'] },
      { nombre: 'chatGPT', sinonimos: [] },
    ],
  });
  assert.equal(repetidos.conceptos.length, 1);
  assert.deepEqual(repetidos.conceptos[0].sinonimos, ['GPT-4']);
});

test('lee el JSON aunque el modelo lo envuelva en texto', async () => {
  const resultado = await generarConsulta('uso de la IA y pensamiento crítico', {
    generar: contesta(
      'Claro:\n```json\n{"conceptos":[{"nombre":"generative AI","sinonimos":["ChatGPT"]}],' +
        '"nota":"Quité Lima."}\n```',
    ),
  });

  assert.deepEqual(resultado.conceptos, [{ nombre: 'generative AI', sinonimos: ['ChatGPT'] }]);
  assert.equal(resultado.nota, 'Quité Lima.');
});

test('una respuesta sin conceptos usables es un 503 del asistente, no un 500', async () => {
  await assert.rejects(
    () => generarConsulta('un tema cualquiera', { generar: contesta('no sé') }),
    (error) => error.statusCode === 503 && error.code === 'ASSISTANT_UNAVAILABLE',
  );
});

test('si el tema no da para conceptos, se le dice al tesista lo que pide la IA, y no es un 503', async () => {
  // El 21-sep «tesis» o «IA» volvían con la lista vacía y una nota pidiendo
  // más detalle; la nota se tiraba y salía «la IA no devolvió conceptos».
  await assert.rejects(
    () =>
      generarConsulta('mi tesis', {
        generar: contesta('{"conceptos":[],"nota":"Proporciona el tema de tu tesis."}'),
      }),
    (error) =>
      error.statusCode === 422 &&
      error.code === 'VALIDATION_ERROR' &&
      /^Proporciona el tema de tu tesis\. Por ejemplo: «/.test(error.message),
  );
});

test('si Gemini falla, 503 del asistente y nunca SERVICE_UNAVAILABLE', async () => {
  const falla = async () => {
    throw new GeminiError('high demand', { status: 503 });
  };

  await assert.rejects(
    () => generarConsulta('un tema cualquiera', { generar: falla }),
    (error) => error.statusCode === 503 && error.code === 'ASSISTANT_UNAVAILABLE',
  );
});

test('sin Gemini o sin Scopus encendidos no se llama a nadie', async () => {
  let llamadas = 0;
  const cuenta = async () => {
    llamadas += 1;
    return { texto: '{}' };
  };

  env.asistenteEnabled = false;
  await assert.rejects(() => generarConsulta('un tema cualquiera', { generar: cuenta }));
  env.asistenteEnabled = true;

  env.scopusApiEnabled = false;
  await assert.rejects(() => generarConsulta('un tema cualquiera', { generar: cuenta }));
  env.scopusApiEnabled = true;

  assert.equal(llamadas, 0);
});
