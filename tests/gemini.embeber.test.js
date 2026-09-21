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

  const primeros = await embeber(['uno', 'dos largo'], { fetchImpl, guardados: null });
  assert.deepEqual(pedidos, ['uno', 'dos largo']);
  assert.deepEqual(primeros, [[3, 1], [9, 1]]);

  // La segunda búsqueda comparte un artículo con la primera: solo se paga el
  // que no se tenía, y el compartido sigue en la posición que le toca.
  const segundos = await embeber(['tres nuevo', 'uno'], { fetchImpl, guardados: null });
  assert.deepEqual(pedidos, ['uno', 'dos largo', 'tres nuevo']);
  assert.deepEqual(segundos, [[10, 1], [3, 1]]);
});

test('la tarea y el modelo forman parte de lo que se recuerda', async () => {
  olvidarVectores();
  const { pedidos, fetchImpl } = geminiDeMentira();

  await embeber(['pregunta'], { tarea: 'RETRIEVAL_QUERY', fetchImpl, guardados: null });
  await embeber(['pregunta'], { tarea: 'RETRIEVAL_DOCUMENT', fetchImpl, guardados: null });
  await embeber(['pregunta'], { tarea: 'RETRIEVAL_QUERY', modelo: 'otro', fetchImpl, guardados: null });

  // El mismo texto con otra tarea u otro modelo es otro vector: reutilizarlo
  // ordenaría por un parecido que no es el que se pidió.
  assert.equal(pedidos.length, 3);
});

test('la memoria tiene tope: lo más viejo se olvida', async () => {
  olvidarVectores();
  const { pedidos, fetchImpl } = geminiDeMentira();
  const muchos = Array.from({ length: 1600 }, (_, i) => `texto ${i}`);

  await embeber(muchos, { fetchImpl, guardados: null });
  assert.equal(pedidos.length, 1600);

  // El último sigue guardado; el primero ya se cayó y hay que volver a pedirlo.
  await embeber(['texto 1599', 'texto 0'], { fetchImpl, guardados: null });
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
    () => embeber(['lo que sea'], { fetchImpl, guardados: null }),
    (error) => error instanceof GeminiError && error.status === 429,
  );

  const segundo = geminiDeMentira();
  await embeber(['lo que sea'], { fetchImpl: segundo.fetchImpl, guardados: null });
  assert.deepEqual(segundo.pedidos, ['lo que sea']);
});

// ── Lo guardado en la base ─────────────────────────────────────────────────

/**
 * Una base de mentira con la misma forma que `vectoresGuardados`: la clave es
 * la de verdad, para que lo que se guarda con un texto se encuentre con él.
 */
function baseDeMentira(inicial = {}) {
  const real = require('../src/lib/vectoresGuardados');
  const filas = new Map(Object.entries(inicial));
  const guardadas = [];
  return {
    filas,
    guardadas,
    claveDe: real.claveDe,
    leer: async (claves) => new Map(claves.filter((c) => filas.has(c)).map((c) => [c, filas.get(c)])),
    guardar: async (nuevas) => {
      for (const f of nuevas) filas.set(f.clave, f.vector);
      guardadas.push(...nuevas);
    },
  };
}

test('lo que está en la base no se le pide a Gemini, y vuelve en su sitio', async () => {
  // La memoria del proceso se vacía en cada reinicio; la base no. Un artículo
  // que buscó cualquier tesista, cualquier día, ya no gasta cuota.
  olvidarVectores();
  const { claveDe } = require('../src/lib/vectoresGuardados');
  const guardados = baseDeMentira({
    [claveDe('modelo-vectores', 'RETRIEVAL_DOCUMENT', 'ya guardado')]: [9, 9],
  });
  const { pedidos, fetchImpl } = geminiDeMentira();

  const vectores = await embeber(['nuevo', 'ya guardado'], { fetchImpl, guardados });

  assert.deepEqual(pedidos, ['nuevo'], 'a Gemini solo lo que no estaba');
  assert.deepEqual(vectores, [[5, 1], [9, 9]], 'y cada uno en su posición');
});

test('lo que calcula Gemini se guarda, con su modelo', async () => {
  olvidarVectores();
  const guardados = baseDeMentira();
  const { fetchImpl } = geminiDeMentira();

  await embeber(['uno', 'dos'], { fetchImpl, guardados });

  assert.equal(guardados.guardadas.length, 2);
  assert.ok(guardados.guardadas.every((f) => f.modelo === 'modelo-vectores' && /^[0-9a-f]{64}$/.test(f.clave)));

  // Y tras un reinicio —memoria vacía— ya no se pide nada.
  olvidarVectores();
  const otra = geminiDeMentira();
  await embeber(['uno', 'dos'], { fetchImpl: otra.fetchImpl, guardados });
  assert.deepEqual(otra.pedidos, []);
});

test('la base guarda el vector y lo devuelve igual, y si falla no rompe nada', async () => {
  const vg = require('../src/lib/vectoresGuardados');
  const vector = [0.123456, -0.5, 1, 0];
  const vuelta = vg.deBytes(vg.aBytes(vector));
  vuelta.forEach((n, i) => assert.ok(Math.abs(n - vector[i]) < 1e-6));

  // Un Buffer que no empieza al principio de su memoria: el caso que rompería
  // un Float32Array leído sin copiar.
  const grande = Buffer.concat([Buffer.from([7]), vg.aBytes(vector)]);
  assert.equal(vg.deBytes(grande.subarray(1)).length, 4);

  const rota = {
    vectorDeTexto: {
      findMany: async () => {
        throw new Error('sin base');
      },
      createMany: async () => {
        throw new Error('sin base');
      },
    },
  };
  assert.deepEqual(await vg.leer(['a'], { db: rota }), new Map(), 'se lee como si no hubiera nada');
  await vg.guardar([{ clave: 'a', modelo: 'm', vector: [1] }], { db: rota });
});
