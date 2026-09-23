'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * La carrera de modelos con proveedores de fuera.
 *
 * En su propio archivo porque `env` se congela la primera vez que se requiere:
 * las claves tienen que estar puestas ANTES, y en `asistente.test.js` ya está
 * cargado. Cada archivo de pruebas corre en su proceso, así que esto no se pisa
 * con lo de al lado.
 *
 * Lo que se prueba es lo que duele si se rompe: que cada prefijo vaya a la
 * dirección de su dueño y no a la del vecino, que el que no lleva clave no
 * mande una cabecera vacía, y que el orden de la carrera sea el que se decidió
 * y no el que salga del objeto.
 */

process.env.GROQ_API_KEY = 'clave-groq';
process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
process.env.NVIDIA_API_KEY = 'nvapi-de-prueba';
process.env.NVIDIA_MODEL = 'openai/gpt-oss-120b';
process.env.OVH_MODEL = 'gpt-oss-120b';

const env = require('../src/config/env');
const { generarEnCompatible, generarConRespaldo, modelosDeTexto, olvidarReposos } = require('../src/lib/gemini');

const RESPUESTA_COMPATIBLE = {
  choices: [{ finish_reason: 'stop', message: { content: 'listo' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const RESPUESTA_GEMINI = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'listo' }] } }] };

/** Un `fetch` que apunta lo que le pidieron y contesta que sí. */
const espia = (cuerpo) => {
  const pedidos = [];
  const fetchImpl = async (url, init) => {
    pedidos.push({ url, headers: init.headers, cuerpo: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => cuerpo };
  };
  return { pedidos, fetchImpl };
};

const unaPregunta = { sistema: 's', mensajes: [{ rol: 'usuario', texto: 'hola' }] };

test('cada proveedor recibe la petición en su propia dirección, con su clave', async () => {
  for (const [proveedor, dominio, clave] of [
    ['groq', 'api.groq.com', 'Bearer clave-groq'],
    ['nvidia', 'integrate.api.nvidia.com', 'Bearer nvapi-de-prueba'],
  ]) {
    const { pedidos, fetchImpl } = espia(RESPUESTA_COMPATIBLE);
    const { texto } = await generarEnCompatible({ ...unaPregunta, proveedor, modelo: 'm', fetchImpl });

    assert.equal(texto, 'listo');
    assert.ok(pedidos[0].url.includes(dominio), `${proveedor} fue a ${pedidos[0].url}`);
    assert.equal(pedidos[0].headers.Authorization, clave);
  }
});

test('OVH va sin cabecera de clave y sin el parámetro de razonamiento', async () => {
  const { pedidos, fetchImpl } = espia(RESPUESTA_COMPATIBLE);
  await generarEnCompatible({ ...unaPregunta, proveedor: 'ovh', modelo: 'gpt-oss-120b', fetchImpl });

  assert.ok(pedidos[0].url.includes('ovh.net'));
  assert.equal(
    pedidos[0].headers.Authorization,
    undefined,
    'el tier anónimo no lleva clave: una cabecera vacía es un 401',
  );
  assert.equal(
    pedidos[0].cuerpo.reasoning_effort,
    undefined,
    'no está comprobado que lo acepte, y un parámetro desconocido tira la petición',
  );
});

test('un proveedor que no existe se queja en vez de preguntar a cualquiera', async () => {
  await assert.rejects(
    generarEnCompatible({ ...unaPregunta, proveedor: 'inventado', modelo: 'm', fetchImpl: async () => {
      throw new Error('no se debería haber pedido nada');
    } }),
    /Proveedor desconocido/,
  );
});

test('en la carrera, «nvidia:<modelo>» va a NVIDIA con el modelo ya sin prefijo', async () => {
  olvidarReposos();
  const { pedidos, fetchImpl } = espia(RESPUESTA_COMPATIBLE);

  const { modelo } = await generarConRespaldo({
    modelos: ['nvidia:openai/gpt-oss-120b'],
    ...unaPregunta,
    fetchImpl,
  });

  assert.equal(modelo, 'nvidia:openai/gpt-oss-120b', 'quien llama sigue viendo el nombre completo');
  assert.ok(pedidos[0].url.includes('integrate.api.nvidia.com'));
  assert.equal(pedidos[0].cuerpo.model, 'openai/gpt-oss-120b', 'al proveedor se le manda sin el prefijo');
});

test('un prefijo que no conocemos NO se parte: va entero a Gemini', async () => {
  olvidarReposos();
  const { pedidos, fetchImpl } = espia(RESPUESTA_GEMINI);

  await generarConRespaldo({ modelos: ['mistral:large'], ...unaPregunta, fetchImpl });

  assert.ok(pedidos[0].url.includes('generativelanguage.googleapis.com'));
  assert.ok(
    pedidos[0].url.includes(encodeURIComponent('mistral:large')),
    'Gemini dirá que ese modelo no existe, que es mejor que irse a un sitio equivocado',
  );
});

test('el orden de la carrera: Gemini, los de fuera con clave, el respaldo y OVH al final', () => {
  assert.deepEqual(modelosDeTexto(), [
    env.GEMINI_MODEL,
    'groq:openai/gpt-oss-120b',
    'nvidia:openai/gpt-oss-120b',
    env.GEMINI_MODEL_RESPALDO,
    'ovh:gpt-oss-120b',
  ]);
});
