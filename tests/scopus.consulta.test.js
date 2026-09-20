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

test('los temas propuestos traen sus variables, y lo que no dijo el modelo queda en nulo', () => {
  const { temas } = normalizar({
    conceptos: [{ nombre: 'burnout', sinonimos: [] }],
    temas: [
      {
        titulo: '  Síndrome de burnout   en enfermeras de   hospitales públicos ',
        independiente: 'carga laboral semanal',
        dependiente: 'nivel de burnout',
        relacion: 'si a mayor carga laboral aumenta el agotamiento',
        poblacion: 'enfermeras asistenciales',
        conceptos: [{ nombre: 'burnout', sinonimos: ['"occupational burnout"'] }],
      },
      {
        // Un cualitativo: sin independiente ni dependiente, y así se queda.
        titulo: 'Vivencias del agotamiento en enfermeras de emergencia',
        relacion: 'cómo describen su agotamiento quienes trabajan en emergencia',
        conceptos: [{ nombre: 'burnout', sinonimos: [] }, { nombre: 'nurses', sinonimos: [] }],
      },
    ],
  });

  assert.equal(temas.length, 2);
  assert.equal(temas[0].titulo, 'Síndrome de burnout en enfermeras de hospitales públicos');
  assert.deepEqual(temas[0].conceptos[0].sinonimos, ['occupational burnout']);
  assert.equal(temas[1].independiente, null);
  assert.equal(temas[1].dependiente, null);
  assert.equal(temas[1].poblacion, null);
  // Los temas comparten conceptos entre sí: el segundo conserva «burnout»
  // aunque ya estuviera en el primero, o se quedaría sin con qué buscarse.
  assert.equal(temas[1].conceptos[0].nombre, 'burnout');
});

test('un tema sin título o sin conceptos no se propone, y hay techo de cuatro', () => {
  const { temas } = normalizar({
    conceptos: [{ nombre: 'burnout', sinonimos: [] }],
    temas: [
      { titulo: 'Sin nada con qué buscar', conceptos: [] },
      { independiente: 'algo', conceptos: [{ nombre: 'stress', sinonimos: [] }] },
      ...Array.from({ length: 6 }, (_, i) => ({
        titulo: `Tema ${i}`,
        conceptos: [{ nombre: `concept ${i}`, sinonimos: [] }],
      })),
    ],
  });

  assert.equal(temas.length, 4);
  assert.deepEqual(
    temas.map((t) => t.titulo),
    ['Tema 0', 'Tema 1', 'Tema 2', 'Tema 3'],
  );
});

test('sin temas en la respuesta, los conceptos siguen sirviendo', () => {
  const { conceptos, temas } = normalizar({ conceptos: [{ nombre: 'burnout', sinonimos: [] }] });

  assert.equal(conceptos.length, 1);
  assert.deepEqual(temas, []);
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
