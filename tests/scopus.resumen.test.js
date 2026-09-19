'use strict';

/**
 * El resumen con citas del buscador de Scopus.
 *
 * Lo que se lleva un tesista de aquí son afirmaciones con su cita al lado, y
 * las va a copiar. Por eso tres cosas no se negocian:
 *
 *   · Ninguna cita apunta a un artículo que no esté en la lista.
 *   · Ningún punto llega a la pantalla sin al menos una cita.
 *   · La IA solo lee resúmenes de verdad: si no hay ninguno, no se inventa
 *     nada a partir de los títulos, se dice.
 *
 * Gemini y OpenAlex se sustituyen: lo que se comprueba es qué se hace con lo
 * que devuelven.
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
sustituir('../src/modules/references/openalex.client', { resumenesPorDoi: async () => new Map() });

const { resumir, normalizar } = require('../src/modules/scopus/scopus.resumen');

const FUENTES = [
  { eid: 'e1', doi: '10.1/A', titulo: 'Primero', anio: 2024 },
  { eid: 'e2', doi: '10.1/b', titulo: 'Segundo', anio: 2023 },
  { eid: 'e3', doi: null, titulo: 'Tercero', anio: 2022 },
];

const conResumenes = async () =>
  new Map([
    ['10.1/a', 'Resumen del primero.'],
    ['10.1/b', 'Resumen del segundo.'],
  ]);

const contesta = (objeto) => async () => ({ texto: JSON.stringify(objeto) });

test('fuera las citas que no son de la lista y los puntos que se quedan sin ninguna', () => {
  const resultado = normalizar(
    {
      titulo: 'T',
      secciones: [
        {
          titulo: 'S',
          puntos: [
            { texto: 'Con cita buena y mala', citas: [2, 9, 0, 2] },
            { texto: 'Sin cita', citas: [] },
            { texto: 'Solo cita inventada', citas: [7] },
          ],
        },
        { titulo: 'Vacía', puntos: [{ texto: 'x', citas: [42] }] },
      ],
    },
    3,
  );

  assert.equal(resultado.secciones.length, 1);
  assert.deepEqual(resultado.secciones[0].puntos, [{ texto: 'Con cita buena y mala', citas: [2] }]);
});

test('sin Markdown en el texto: la web lo pinta tal cual', () => {
  const resultado = normalizar(
    { titulo: '**Negrita**', secciones: [{ titulo: '## S', puntos: [{ texto: 'a *b*', citas: [1] }] }] },
    1,
  );
  assert.equal(resultado.titulo, 'Negrita');
  assert.equal(resultado.secciones[0].titulo, 'S');
  assert.equal(resultado.secciones[0].puntos[0].texto, 'a b');
});

test('la IA lee los resúmenes de OpenAlex, y se dice cuáles tenía', async () => {
  let leido = '';
  const generar = async ({ mensajes }) => {
    leido = mensajes[0].texto;
    return {
      texto: JSON.stringify({ titulo: 'T', secciones: [{ titulo: 'S', puntos: [{ texto: 'p', citas: [1] }] }] }),
    };
  };

  const resultado = await resumir(
    { pregunta: '¿Qué dicen?', fuentes: FUENTES },
    { generar, resumenes: conResumenes },
  );

  assert.ok(leido.includes('[1] Primero (2024)\nResumen: Resumen del primero.'));
  assert.ok(leido.includes('[3] Tercero (2022)\nResumen: (no disponible)'));
  assert.deepEqual(resultado.conResumen, [1, 2]);
});

test('sin ningún resumen no se inventa nada a partir de los títulos', async () => {
  let llamadas = 0;
  const generar = async () => {
    llamadas += 1;
    return { texto: '{}' };
  };

  await assert.rejects(
    () => resumir({ pregunta: '¿Qué dicen?', fuentes: FUENTES }, { generar, resumenes: async () => new Map() }),
    /Ninguno de estos artículos tiene resumen/,
  );
  assert.equal(llamadas, 0);
});

test('un resumen sin puntos citables es un 503 del asistente, no un 500', async () => {
  await assert.rejects(
    () =>
      resumir(
        { pregunta: '¿Qué dicen?', fuentes: FUENTES },
        { generar: contesta({ secciones: [{ titulo: 'S', puntos: [{ texto: 'x', citas: [] }] }] }), resumenes: conResumenes },
      ),
    (error) => error.statusCode === 503 && error.code === 'ASSISTANT_UNAVAILABLE',
  );
});

test('las preguntas anteriores viajan como contexto de la de seguimiento', async () => {
  let leido = '';
  const generar = async ({ mensajes }) => {
    leido = mensajes[0].texto;
    return {
      texto: JSON.stringify({ titulo: 'T', secciones: [{ titulo: 'S', puntos: [{ texto: 'p', citas: [2] }] }] }),
    };
  };

  await resumir(
    {
      pregunta: '¿Y en secundaria?',
      fuentes: FUENTES,
      anteriores: [{ pregunta: '¿Qué dicen?', respuesta: 'Que mejora.' }],
    },
    { generar, resumenes: conResumenes },
  );

  assert.ok(leido.startsWith('Pregunta anterior: ¿Qué dicen?\nRespuesta anterior: Que mejora.'));
  assert.ok(leido.includes('Pregunta: ¿Y en secundaria?'));
});
