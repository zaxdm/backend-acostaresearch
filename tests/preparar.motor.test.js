'use strict';

/**
 * El motor de «Preparar documento»: cómo se reparte el trabajo y, sobre todo,
 * qué se le deja entrar al Word.
 *
 * Nadie mira el resultado antes de entregarlo. Todo lo que el modelo haga mal y
 * no se detecte aquí, se entrega firmado por el cliente. Por eso las pruebas
 * que más pesan son las de `comprobar`: cifras cambiadas, párrafos vaciados,
 * párrafos partidos en dos y excusas en vez de texto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const motor = require('../src/modules/preparar/preparar.motor');

const parrafo = (id, texto) => ({ id, texto, palabras: texto.split(/\s+/).length });

const EDICION = { servicio: 'EDICION' };
const AL_INGLES = { servicio: 'TRADUCCION', idioma: 'en' };
const AL_CHINO = { servicio: 'TRADUCCION', idioma: 'zh' };

// ── Repartir el trabajo ────────────────────────────────────────────────────

test('las tandas no pasan del tope de palabras', () => {
  const parrafos = Array.from({ length: 10 }, (_, i) => parrafo(i + 1, 'una dos tres cuatro cinco'));
  const tandas = motor.tandasDe(parrafos, 12);

  assert.equal(tandas.length, 5);
  for (const tanda of tandas) {
    assert.ok(tanda.reduce((n, p) => n + p.palabras, 0) <= 12);
  }
});

test('un párrafo más largo que el tope va solo, nunca partido', () => {
  const parrafos = [parrafo(1, 'corto'), parrafo(2, Array(50).fill('palabra').join(' '))];
  const tandas = motor.tandasDe(parrafos, 10);

  assert.deepEqual(tandas.map((t) => t.map((p) => p.id)), [[1], [2]]);
});

test('no se lanzan más peticiones a la vez de las permitidas', async () => {
  let enVuelo = 0;
  let maximo = 0;

  const tareas = Array.from({ length: 9 }, (_, i) => async () => {
    enVuelo += 1;
    maximo = Math.max(maximo, enVuelo);
    await new Promise((listo) => setTimeout(listo, 5));
    enVuelo -= 1;
    return i;
  });

  const resultados = await motor.enParalelo(tareas, 3);

  assert.equal(maximo, 3);
  assert.deepEqual(resultados, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

// ── Lo que no se deja pasar ────────────────────────────────────────────────

test('una cifra cambiada se rechaza: es el error que arruina un resultado', () => {
  const original = 'La muestra fue de 120 estudiantes (M = 21.4, DE = 2.3).';

  assert.equal(motor.comprobar(original, 'The sample was 120 students (M = 21.4, SD = 2.3).', AL_INGLES), null);
  assert.match(
    motor.comprobar(original, 'The sample was 130 students (M = 21.4, SD = 2.3).', AL_INGLES),
    /las cifras no son las mismas/,
  );
});

test('el separador decimal puede cambiar de idioma sin que cuente como otra cifra', () => {
  // «3.5» en inglés y «3,5» en español son la misma cifra.
  assert.equal(motor.comprobar('El valor fue 3,5 puntos.', 'The value was 3.5 points.', AL_INGLES), null);
});

test('un párrafo devuelto vacío se rechaza', () => {
  assert.match(motor.comprobar('Un texto cualquiera.', '   ', EDICION), /vacío/);
  assert.match(motor.comprobar('Un texto cualquiera.', undefined, EDICION), /no devolvió este párrafo/);
});

test('una excusa del modelo no es una traducción', () => {
  assert.match(
    motor.comprobar('Un texto cualquiera y suficientemente largo.', 'I cannot help with that.', AL_INGLES),
    /excusa/,
  );
  assert.match(
    motor.comprobar('Un texto cualquiera y suficientemente largo.', 'Lo siento, no puedo hacerlo.', AL_INGLES),
    /excusa/,
  );
});

test('un párrafo partido en dos se rechaza: desplazaría todo lo que va detrás', () => {
  assert.match(
    motor.comprobar('Una frase. Y otra frase.', 'Una frase.\n\nY otra frase.', EDICION),
    /partió el párrafo/,
  );
});

test('lo que encoge o crece demasiado se rechaza, con margen según el idioma', () => {
  const largo =
    'El rendimiento académico de los estudiantes universitarios depende de múltiples ' +
    'factores personales, familiares e institucionales que interactúan entre sí.';

  // Resumir no es traducir ni corregir.
  assert.match(motor.comprobar(largo, 'Depende de varios factores.', AL_INGLES), /más corto/);

  // Pero el chino SÍ escribe mucho más corto, y ahí lo mismo es normal.
  assert.equal(motor.margenes(AL_CHINO).minimo < motor.margenes(AL_INGLES).minimo, true);
  assert.equal(motor.comprobar(largo, '大学生的学业成绩取决于个人、家庭和机构等多种因素。', AL_CHINO), null);
});

test('corregir el inglés casi no cambia el largo: el margen es el más estrecho', () => {
  assert.ok(motor.margenes(EDICION).maximo < motor.margenes(AL_INGLES).maximo);
});

test('un párrafo devuelto igual es una respuesta correcta', () => {
  const texto = 'The results show a significant effect on academic performance.';
  assert.equal(motor.comprobar(texto, texto, EDICION), null);
});

// ── Pedirlo, con el modelo falsificado ─────────────────────────────────────

/** Un `generar` de mentira: devuelve lo que diga `responder` para cada tanda. */
function modeloFalso(responder) {
  const llamadas = [];
  const generar = async ({ mensajes }) => {
    const entrada = JSON.parse(mensajes[0].texto);
    llamadas.push(entrada);
    return { texto: JSON.stringify(responder(entrada, llamadas.length)) };
  };
  return { generar, llamadas };
}

const DOS = [parrafo(1, 'The results shows an effect.'), parrafo(2, 'The data was collected.')];

test('devuelve solo los párrafos que de verdad cambiaron', async () => {
  const { generar } = modeloFalso((entrada) => ({
    1: 'The results show an effect.',
    // El segundo vuelve igual: no es un cambio y no tiene que tocarse su XML.
    2: entrada['2'],
  }));

  const { cambios } = await motor.prepararParrafos({
    parrafos: DOS,
    servicio: 'EDICION',
    generar,
    porTanda: 100,
  });

  assert.deepEqual(Object.keys(cambios), ['1']);
  assert.equal(cambios['1'].original, 'The results shows an effect.');
  assert.equal(cambios['1'].texto, 'The results show an effect.');
});

test('el párrafo que el modelo se dejó se le vuelve a pedir, él solo', async () => {
  const { generar, llamadas } = modeloFalso((entrada, vuelta) =>
    // Primera vuelta: se «olvida» el segundo. Segunda: se le pide solo.
    vuelta === 1 ? { 1: 'The results show an effect.' } : { 2: 'The data were collected.' },
  );

  const { cambios, malos } = await motor.prepararParrafos({
    parrafos: DOS,
    servicio: 'EDICION',
    generar,
    porTanda: 100,
  });

  assert.equal(llamadas.length, 2);
  assert.deepEqual(Object.keys(llamadas[1]), ['2'], 'la segunda llamada lleva solo el que falló');
  assert.deepEqual(Object.keys(cambios).sort(), ['1', '2']);
  assert.deepEqual(malos, []);
});

test('lo que falla dos veces se deja intacto y se dice cuál y por qué', async () => {
  const { generar } = modeloFalso(() => ({ 1: 'The results show an effect.', 2: '' }));

  const { cambios, malos } = await motor.prepararParrafos({
    parrafos: DOS,
    servicio: 'EDICION',
    generar,
    porTanda: 100,
  });

  assert.deepEqual(Object.keys(cambios), ['1']);
  assert.equal(malos.length, 1);
  assert.equal(malos[0].id, 2);
  assert.match(malos[0].motivo, /vacío/);
});

test('si una tanda entera revienta, sus párrafos se reintentan uno a uno', async () => {
  let primera = true;
  const generar = async ({ mensajes }) => {
    if (primera) {
      primera = false;
      throw new Error('Gemini respondió 503');
    }
    const entrada = JSON.parse(mensajes[0].texto);
    return { texto: JSON.stringify(Object.fromEntries(Object.keys(entrada).map((id) => [id, 'Corregido.']))) };
  };

  const { cambios } = await motor.prepararParrafos({
    parrafos: DOS,
    servicio: 'EDICION',
    generar,
    porTanda: 100,
    // Un 503 es saturación: ahora se espera antes de volver a probar, y en la
    // prueba esa espera es de un milisegundo.
    reintento: { esperaMs: 1 },
  });

  assert.deepEqual(Object.keys(cambios).sort(), ['1', '2']);
});

test('si no sale NI UN párrafo, se lanza: entregar el mismo Word sería estafar', async () => {
  const generar = async () => {
    throw new Error('Gemini respondió 503');
  };

  await assert.rejects(
    motor.prepararParrafos({
      parrafos: DOS,
      servicio: 'EDICION',
      generar,
      porTanda: 100,
      reintento: { esperaMs: 1 },
    }),
    /503/,
  );
});

// ── Lo que vuelve sin traducir ─────────────────────────────────────────────

/**
 * El 24-sep-2026 una entrega real salió con dos títulos en español y una nota
 * entre corchetes en español dentro de una celda en inglés. El modelo los
 * devolvió así, y un párrafo devuelto igual se daba por bueno sin más.
 */
test('un título devuelto en español se vuelve a pedir, todos juntos en una llamada', async () => {
  const parrafos = [
    parrafo(1, 'CAPÍTULO I: PROBLEMA Y OBJETIVOS'),
    parrafo(2, 'Justificación'),
    parrafo(3, 'Se aplicará un cuestionario [previsto, se confirma en la Skill de Instrumento].'),
    parrafo(4, 'Esteban Zait Dioses Muñoz'),
  ];
  const { generar, llamadas } = modeloFalso((entrada, vuelta) =>
    vuelta === 1
      ? {
          1: entrada['1'],
          2: entrada['2'],
          3: 'A questionnaire will be applied [previsto, se confirma en la Skill de Instrumento].',
          4: entrada['4'],
        }
      : {
          1: 'CHAPTER I: PROBLEM AND OBJECTIVES',
          2: 'Justification',
          3: 'A questionnaire will be applied [planned, confirmed in the Instrument Skill].',
          4: entrada['4'],
        },
  );

  const { cambios } = await motor.prepararParrafos({ parrafos, ...AL_INGLES, generar, porTanda: 100 });

  assert.equal(llamadas.length, 2, 'una sola llamada de más, no una por párrafo');
  assert.deepEqual(Object.keys(llamadas[1]).sort(), ['1', '2', '3', '4']);
  assert.equal(cambios['1'].texto, 'CHAPTER I: PROBLEM AND OBJECTIVES');
  assert.equal(cambios['2'].texto, 'Justification');
  assert.match(cambios['3'].texto, /\[planned, confirmed in the Instrument Skill\]/);
  assert.equal(cambios['4'], undefined, 'un nombre propio que vuelve igual se acepta');
});

test('si la segunda vuelta falla, se queda lo que ya había y el trabajo sigue', async () => {
  const parrafos = [parrafo(1, 'Justificación'), parrafo(2, 'La muestra fue de 120 usuarios.')];
  let vuelta = 0;
  const generar = async ({ mensajes }) => {
    vuelta += 1;
    if (vuelta > 1) throw new Error('el modelo no devolvió un JSON que se pueda leer');
    const entrada = JSON.parse(mensajes[0].texto);
    return { texto: JSON.stringify({ 1: entrada['1'], 2: 'The sample was 120 users.' }) };
  };

  const { cambios } = await motor.prepararParrafos({ parrafos, ...AL_INGLES, generar, porTanda: 100 });

  assert.deepEqual(Object.keys(cambios), ['2']);
});

test('corrigiendo el inglés no hay segunda vuelta: devolver igual es lo normal', async () => {
  const { generar, llamadas } = modeloFalso((entrada) => entrada);

  const { cambios } = await motor.prepararParrafos({
    parrafos: [parrafo(1, 'Justificación del estudio')],
    ...EDICION,
    generar,
    porTanda: 100,
  });

  assert.equal(llamadas.length, 1);
  assert.deepEqual(cambios, {});
});

test('lo que sigue en español se reconoce; lo traducido con un apellido, no', () => {
  assert.equal(motor.sigueSinTraducir('Justificación', 'Justificación', 'en'), true);
  assert.equal(motor.sigueSinTraducir('Justificación', 'Justification', 'en'), false);
  assert.equal(
    motor.sigueSinTraducir('Según de la Cruz (2020)', 'According to de la Cruz (2020)', 'en'),
    false,
  );
  assert.equal(motor.sigueSinTraducir('ISO/IEC 25010', 'ISO/IEC 25010', 'en'), false);
  // Al portugués, «de», «que» y «se» son suyas: solo cuenta lo que vuelve igual.
  assert.equal(motor.sigueSinTraducir('La muestra', 'A amostra de que se fala', 'pt'), false);
  assert.equal(motor.sigueSinTraducir('Justificación', 'Justificación', 'es'), false);
});

// ── Las cifras ─────────────────────────────────────────────────────────────

test('mover una cifra de sitio dentro de la frase no tira el párrafo', () => {
  // Las instrucciones le PIDEN al modelo que reordene para que se lea natural,
  // y compararlas en fila castigaba justo eso. Este caso es real: se vio el
  // 22-sep-2026 midiendo contra un manuscrito corregido por una editorial, que
  // movió «3 duplicates were removed» de sitio. Nuestra comprobación habría
  // tirado esa corrección buena.
  const antes = 'After merging (97 records), the filter left 74 documents. After 3 duplicates were removed, 100 records remained.';
  const despues = 'After 3 duplicates were removed and merging left 97 records, the filter left 74 documents, with 100 remaining.';

  assert.equal(motor.comprobar(antes, despues, { servicio: 'EDICION' }), null);
});

test('pero cambiar, añadir o perder una cifra sigue tirándolo', () => {
  const antes = 'The sample of 74 students answered 3 items in 2024.';
  const como = { servicio: 'EDICION' };

  assert.match(motor.comprobar(antes, antes.replace('74', '75'), como), /cifras/);
  assert.match(motor.comprobar(antes, antes.replace('in 2024', 'in 2024 and 2025'), como), /cifras/);
  assert.match(motor.comprobar(antes, antes.replace('3 items', 'some items'), como), /cifras/);
});

// ── Lo que devuelve el modelo ──────────────────────────────────────────────

test('una respuesta que no es JSON se dice con esas palabras, no con un error de programa', async () => {
  // Antes esto se comprobaba sobre los resúmenes, que se retiraron el
  // 22-sep-2026. La garantía es la misma y el camino, el que queda.
  await assert.rejects(
    motor.prepararParrafos({
      parrafos: [parrafo(1, 'The results shows an effect in the group.')],
      servicio: 'EDICION',
      generar: async () => ({ texto: 'Aquí tienes tu corrección: ...' }),
      reintento: { intentos: 0 },
    }),
    /JSON/,
  );
});

// ── Cuando Google está saturado ────────────────────────────────────────────

test('si el modelo está saturado se espera y se vuelve a probar', async () => {
  let llamadas = 0;
  const generar = async () => {
    llamadas += 1;
    if (llamadas === 1) {
      throw new Error('This model is currently experiencing high demand. Please try again later.');
    }
    return { texto: 'listo' };
  };

  const hecho = await motor.conReintento(generar, { esperaMs: 1 })({});

  assert.equal(llamadas, 2);
  assert.equal(hecho.texto, 'listo');
});

test('un fallo que no es saturación no se reintenta: gastaría dinero para nada', async () => {
  let llamadas = 0;
  const generar = async () => {
    llamadas += 1;
    throw new Error('La clave de la API no es válida');
  };

  await assert.rejects(motor.conReintento(generar, { esperaMs: 1 })({}), /clave/);
  assert.equal(llamadas, 1);
});

test('si sigue saturado tras los reintentos, se rinde con el mensaje de Google', async () => {
  let llamadas = 0;
  const generar = async () => {
    llamadas += 1;
    throw new Error('503 Service Unavailable');
  };

  await assert.rejects(motor.conReintento(generar, { esperaMs: 1, intentos: 2 })({}), /Unavailable/);
  assert.equal(llamadas, 3, 'el primero y dos reintentos');
});

test('una tanda no se pierde por un pico de demanda: se espera y se vuelve a pedir', async () => {
  let llamadas = 0;
  const { cambios } = await motor.prepararParrafos({
    parrafos: [parrafo(1, 'The results shows an effect in the group of participants.')],
    servicio: 'EDICION',
    reintento: { esperaMs: 1 },
    generar: async ({ mensajes }) => {
      llamadas += 1;
      if (llamadas === 1) throw new Error('This model is currently experiencing high demand.');
      const entrada = JSON.parse(mensajes[0].texto);
      return {
        texto: JSON.stringify(
          Object.fromEntries(
            Object.keys(entrada).map((id) => [id, 'The results show an effect in the group of participants.']),
          ),
        ),
      };
    },
  });

  assert.equal(llamadas, 2);
  assert.equal(cambios['1'].texto, 'The results show an effect in the group of participants.');
});
