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
  });

  assert.deepEqual(Object.keys(cambios).sort(), ['1', '2']);
});

test('si no sale NI UN párrafo, se lanza: entregar el mismo Word sería estafar', async () => {
  const generar = async () => {
    throw new Error('Gemini respondió 503');
  };

  await assert.rejects(
    motor.prepararParrafos({ parrafos: DOS, servicio: 'EDICION', generar, porTanda: 100 }),
    /503/,
  );
});

// ── Resúmenes ──────────────────────────────────────────────────────────────

test('para el resumen se manda el principio y el final, no el marco teórico de en medio', () => {
  const parrafos = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    texto: `Párrafo ${i + 1}`,
    palabras: 10,
  }));

  const { parrafos: elegidos, recortado } = motor.extractoPara(parrafos, 100);

  assert.equal(recortado, true);
  assert.deepEqual(elegidos.map((p) => p.id), [1, 2, 3, 4, 5, 26, 27, 28, 29, 30]);
});

test('si el documento cabe entero, se manda entero', () => {
  const parrafos = [parrafo(1, 'uno'), parrafo(2, 'dos')];
  const { parrafos: elegidos, recortado } = motor.extractoPara(parrafos, 100);

  assert.equal(recortado, false);
  assert.equal(elegidos.length, 2);
});

test('el resumen exige las cuatro piezas: si falta una, no se entrega a medias', async () => {
  const completo = {
    resumen: 'El objetivo fue medir el rendimiento.',
    abstract: 'The aim was to measure performance.',
    palabrasClave: 'rendimiento; universidad',
    keywords: 'performance; university',
  };

  const bien = await motor.resumenDe({
    parrafos: [parrafo(1, 'texto')],
    generar: async () => ({ texto: JSON.stringify(completo) }),
  });
  assert.equal(bien.abstract, 'The aim was to measure performance.');
  assert.ok(bien.palabrasDelResumen > 0);

  await assert.rejects(
    motor.resumenDe({
      parrafos: [parrafo(1, 'texto')],
      generar: async () => ({ texto: JSON.stringify({ ...completo, keywords: '  ' }) }),
    }),
    /keywords/,
  );
});

test('una respuesta que no es JSON se dice con esas palabras, no con un error de programa', async () => {
  await assert.rejects(
    motor.resumenDe({
      parrafos: [parrafo(1, 'texto')],
      generar: async () => ({ texto: 'Aquí tienes tu resumen: ...' }),
    }),
    /JSON/,
  );
});
