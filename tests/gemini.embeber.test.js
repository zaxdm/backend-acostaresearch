'use strict';

/**
 * Los vectores de Gemini y lo que se recuerda de ellos.
 *
 * El plan gratuito de Gemini cuenta CADA TEXTO que se embebe, no cada
 * petición: cien al minuto. Una búsqueda por significado son cuarenta y uno,
 * así que la segunda del minuto vive de lo que se recordó de la primera. Tres
 * cosas tienen que ser ciertas:
 *
 *   · Lo ya calculado no se vuelve a pedir, y lo pedido vuelve en su sitio:
 *     quien llama compara los vectores POR POSICIÓN, y una mezcla ordenaría
 *     los artículos por el significado de otro.
 *   · La memoria tiene tope: esto vive en un proceso que no se reinicia en
 *     semanas.
 *   · Quedarse sin cuota llega como un error con su 429, que es lo que
 *     distingue «espera un momento» de «Gemini está caído».
 *
 * `fetch` se sustituye: lo que se comprueba es qué se pide, no cómo se habla
 * con Google.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/config/env', {
  asistenteEnabled: true,
  GEMINI_API_KEY: 'clave',
  GEMINI_EMBEDDING_MODEL: 'modelo-vectores',
});
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { embeber, olvidarVectores, GeminiError } = require('../src/lib/gemini');

/** Un Gemini de mentira que devuelve un vector por texto y apunta qué le pidieron. */
function geminiDeMentira() {
  const pedidos = [];
  const fetchImpl = async (url, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    const textos = cuerpo.requests.map((r) => r.content.parts[0].text);
    pedidos.push(...textos);
    return {
      ok: true,
      status: 200,
      json: async () => ({ embeddings: textos.map((t) => ({ values: [t.length, 1] })) }),
    };
  };
  return { pedidos, fetchImpl };
}

test('lo ya calculado no se vuelve a pedir, y cada vector vuelve en su sitio', async () => {
  olvidarVectores();
  const { pedidos, fetchImpl } = geminiDeMentira();

  const primeros = await embeber(['uno', 'dos largo'], { fetchImpl });
  assert.deepEqual(pedidos, ['uno', 'dos largo']);
  assert.deepEqual(primeros, [[3, 1], [9, 1]]);

  // La segunda búsqueda comparte un artículo con la primera: solo se paga el
  // que no se tenía, y el compartido sigue en la posición que le toca.
  const segundos = await embeber(['tres nuevo', 'uno'], { fetchImpl });
  assert.deepEqual(pedidos, ['uno', 'dos largo', 'tres nuevo']);
  assert.deepEqual(segundos, [[10, 1], [3, 1]]);
});

test('la tarea y el modelo forman parte de lo que se recuerda', async () => {
  olvidarVectores();
  const { pedidos, fetchImpl } = geminiDeMentira();

  await embeber(['pregunta'], { tarea: 'RETRIEVAL_QUERY', fetchImpl });
  await embeber(['pregunta'], { tarea: 'RETRIEVAL_DOCUMENT', fetchImpl });
  await embeber(['pregunta'], { tarea: 'RETRIEVAL_QUERY', modelo: 'otro', fetchImpl });

  // El mismo texto con otra tarea u otro modelo es otro vector: reutilizarlo
  // ordenaría por un parecido que no es el que se pidió.
  assert.equal(pedidos.length, 3);
});

test('la memoria tiene tope: lo más viejo se olvida', async () => {
  olvidarVectores();
  const { pedidos, fetchImpl } = geminiDeMentira();
  const muchos = Array.from({ length: 1600 }, (_, i) => `texto ${i}`);

  await embeber(muchos, { fetchImpl });
  assert.equal(pedidos.length, 1600);

  // El último sigue guardado; el primero ya se cayó y hay que volver a pedirlo.
  await embeber(['texto 1599', 'texto 0'], { fetchImpl });
  assert.deepEqual(pedidos.slice(1600), ['texto 0']);
});

test('quedarse sin cuota llega con su 429, y nada se recuerda a medias', async () => {
  olvidarVectores();
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'You exceeded your current quota' } }),
  });

  await assert.rejects(
    () => embeber(['lo que sea'], { fetchImpl }),
    (error) => error instanceof GeminiError && error.status === 429,
  );

  const segundo = geminiDeMentira();
  await embeber(['lo que sea'], { fetchImpl: segundo.fetchImpl });
  assert.deepEqual(segundo.pedidos, ['lo que sea']);
});
