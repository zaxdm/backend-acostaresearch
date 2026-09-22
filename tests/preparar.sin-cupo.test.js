'use strict';

/**
 * Cuando el proveedor nos corta por tope de uso.
 *
 * DE DÓNDE SALE ESTA PRUEBA
 * -------------------------
 * Del 22-sep-2026. Un manuscrito de 12.164 palabras —catorce tandas— se mandó a
 * corregir y volvió con esto, tal cual, en la pantalla del cliente:
 *
 *   «You exceeded your current quota, please check your plan and billing
 *    details. […] Quota exceeded for metric: generate_content_free_tier_requests,
 *    limit: 20, model: gemini-3.5-flash. Please retry in 35.72315»
 *
 * Tres cosas mal a la vez:
 *
 *   1. `SATURADO` no reconocía ese texto. Google escribe «rate-limits» con
 *      guion y la expresión pedía «rate limit» con espacio, así que no se
 *      esperaba: se daba la tanda por perdida a la primera.
 *   2. Y entonces se pedía CADA PÁRRAFO de esa tanda por separado. Contra un
 *      tope de peticiones, eso multiplica por veinte justo lo que sobra.
 *   3. El error de Google, en inglés y con enlaces a la consola de facturación,
 *      se le enseñaba al cliente como si fuera cosa suya.
 *
 * Lo que se fija aquí:
 *   · Un 503 pasajero se sigue tratando como antes: se espera y se reintenta
 *     párrafo a párrafo, que casi siempre sale.
 *   · Quedarse sin cupo NO: para las tandas que faltan, no reintenta nada y da
 *     el trabajo por fallido, que no le gasta documento del mes.
 *   · Se espera lo que dice Google que hay que esperar, no dos segundos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const motor = require('../src/modules/preparar/preparar.motor');
const gemini = require('../src/lib/gemini');

/** El texto exacto que devolvió Google el 22-sep. */
const CUOTA =
  'You exceeded your current quota, please check your plan and billing details. For more ' +
  'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To ' +
  'monitor your current usage, head to: https://ai.dev/rate-limit. * Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: ' +
  'gemini-3.5-flash Please retry in 35.72315';

/** Párrafos de prueba SIN cifras: el motor exige que no cambien, y aquí estorban. */
const parrafos = (cuantos) =>
  Array.from({ length: cuantos }, (nada, i) => ({
    id: i + 1,
    texto: `The study shows a clear effect in the group of participants that took part.`,
    palabras: 10,
  }));

// ── Reconocerlo ────────────────────────────────────────────────────────────

test('el texto de Google se reconoce como que no nos dejan preguntar', () => {
  assert.equal(motor.SATURADO.test(CUOTA), true);
});

test('y se distingue de un pico pasajero: uno para el trabajo y el otro no', () => {
  assert.equal(motor.seAcaboElCupo({ message: CUOTA }), true);
  assert.equal(motor.seAcaboElCupo({ status: 429 }), true);

  assert.equal(motor.seAcaboElCupo({ message: 'Gemini respondió 503' }), false);
  assert.equal(
    motor.seAcaboElCupo({ message: 'This model is currently experiencing high demand' }),
    false,
  );
});

test('del error se saca cuánto pide Google que se espere', () => {
  assert.equal(gemini.esperaPedida(null, CUOTA), 35_723);

  const conRetryInfo = {
    error: {
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '36s' },
      ],
    },
  };
  assert.equal(gemini.esperaPedida(conRetryInfo, CUOTA), 36_000);
  assert.equal(gemini.esperaPedida(null, 'Gemini respondió 503'), null);
});

// ── No multiplicar el corte ────────────────────────────────────────────────

test('quedarse sin cupo NO se reintenta párrafo a párrafo', async () => {
  let llamadas = 0;
  const generar = async () => {
    llamadas += 1;
    const error = new Error(CUOTA);
    error.status = 429;
    throw error;
  };

  await assert.rejects(
    motor.prepararParrafos({
      parrafos: parrafos(40),
      servicio: 'EDICION',
      generar,
      porTanda: 100,
      aLaVez: 1,
      reintento: { intentos: 1, esperaMs: 1 },
    }),
    (error) => error.message === motor.SIN_CUPO_DEL_PROVEEDOR,
  );

  // Cuatro tandas de diez párrafos. Solo la primera llega a preguntar —dos
  // veces, por el reintento—; las otras tres ni lo intentan. Antes eran esas
  // cuatro MÁS una llamada por cada uno de los cuarenta párrafos.
  assert.equal(llamadas, 2);
});

test('al cliente se le dice en su idioma, no el error de Google', async () => {
  const generar = async () => {
    const error = new Error(CUOTA);
    error.status = 429;
    throw error;
  };

  await assert.rejects(
    motor.prepararParrafos({
      parrafos: parrafos(4),
      servicio: 'TRADUCCION',
      idioma: 'en',
      generar,
      porTanda: 100,
      reintento: { intentos: 0 },
    }),
    (error) => {
      assert.doesNotMatch(error.message, /quota|billing|http/i);
      assert.match(error.message, /no te hemos descontado ningún documento/i);
      return true;
    },
  );
});

test('un trabajo cortado a medias no se entrega, aunque parte hubiera salido', async () => {
  let primera = true;
  const generar = async ({ mensajes }) => {
    if (primera) {
      primera = false;
      const entrada = JSON.parse(mensajes[0].texto);
      return {
        texto: JSON.stringify(
          Object.fromEntries(Object.keys(entrada).map((id) => [id, 'The study showed a clear effect in the group of participants who took part.'])),
        ),
      };
    }
    const error = new Error(CUOTA);
    error.status = 429;
    throw error;
  };

  // La primera tanda sale bien y la segunda se topa con el tope. Entregar el
  // manuscrito con la mitad corregida, cobrando un documento del mes, es peor
  // que no haber empezado.
  await assert.rejects(
    motor.prepararParrafos({
      parrafos: parrafos(20),
      servicio: 'EDICION',
      generar,
      porTanda: 100,
      aLaVez: 1,
      reintento: { intentos: 0 },
    }),
    (error) => error.message === motor.SIN_CUPO_DEL_PROVEEDOR,
  );
});

// ── Un pico pasajero sigue funcionando como antes ──────────────────────────

test('un 503 en una tanda no tumba el trabajo: se reintenta y sale', async () => {
  let primera = true;
  const generar = async ({ mensajes }) => {
    if (primera) {
      primera = false;
      throw new Error('Gemini respondió 503');
    }
    const entrada = JSON.parse(mensajes[0].texto);
    return {
      texto: JSON.stringify(Object.fromEntries(Object.keys(entrada).map((id) => [id, 'The study showed a clear effect in the group of participants who took part.']))),
    };
  };

  const { cambios, malos } = await motor.prepararParrafos({
    parrafos: parrafos(4),
    servicio: 'EDICION',
    generar,
    porTanda: 1000,
    reintento: { esperaMs: 1 },
  });

  assert.deepEqual(malos, []);
  assert.equal(Object.keys(cambios).length, 4);
});

// ── Esperar lo que pide, no lo que nos parece ──────────────────────────────

test('se espera lo que dice Google, no los seis segundos de siempre', async () => {
  const esperas = [];
  const original = global.setTimeout;

  // `conReintento` duerme con setTimeout: se apunta cuánto y se sigue ya.
  global.setTimeout = (fn, ms) => {
    esperas.push(ms);
    return original(fn, 0);
  };

  try {
    let primera = true;
    const generar = async ({ mensajes }) => {
      if (primera) {
        primera = false;
        const error = new Error(CUOTA);
        error.esperarMs = 35_723;
        throw error;
      }
      const entrada = JSON.parse(mensajes[0].texto);
      return {
        texto: JSON.stringify(Object.fromEntries(Object.keys(entrada).map((id) => [id, 'The study showed a clear effect in the group of participants who took part.']))),
      };
    };

    await motor.prepararParrafos({
      parrafos: parrafos(2),
      servicio: 'EDICION',
      generar,
      porTanda: 1000,
    });
  } finally {
    global.setTimeout = original;
  }

  assert.ok(
    esperas.some((ms) => ms === 35_723),
    `se esperaba la espera que pidió Google; se esperó ${esperas.join(', ')}`,
  );
});
