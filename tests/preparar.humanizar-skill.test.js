'use strict';

/**
 * «Humanizar» con la skill del servidor (`preparar.humanizar`, 21-oct-2026).
 *
 * Lo que se fija: cada capítulo va con su ruta, lo que falla dos veces tiene
 * un tercer intento, y las pasadas sobre el documento entero quitan el relleno
 * y los moldes repetidos sin dejar pasar una cifra cambiada.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const humanizador = require('../src/modules/preparar/preparar.humanizar');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');

let siguiente = 1;
function parrafo(texto, nivel = null) {
  const clave = String(siguiente++);
  return { clave, id: Number(clave), texto, nivel, palabras: cuerpo.palabrasDe(texto), citas: null };
}

const METODO =
  'La investigación fue de tipo básica y de enfoque cuantitativo, con un diseño no experimental. ' +
  'La población estuvo conformada por 420 estudiantes de la facultad y la muestra por 201 de ellos.';
const METODO_NUEVO =
  'Se trabajó con 201 de los 420 estudiantes de la facultad, en una investigación básica de enfoque ' +
  'cuantitativo cuyo diseño fue no experimental porque nada se manipuló.';

const RESULTADO =
  'En la tabla 1 se observa que el 46,3 % de los estudiantes se ubicó en el nivel alto de la competencia. ' +
  'Asimismo, el 38,8 % se ubicó en el nivel medio y el 14,9 % en el nivel bajo de la variable.';
const RESULTADO_NUEVO =
  'Casi la mitad de los estudiantes, el 46,3 %, quedó en el nivel alto de la competencia (Tabla 1), ' +
  'mientras que el 38,8 % llegó al nivel medio y el 14,9 % se quedó en el bajo.';

const DISCUSION =
  'Los resultados obtenidos guardan relación con lo encontrado por Quispe y Mamani (2023) en Puno. ' +
  'Esta coincidencia refuerza la validez externa de los hallazgos de la presente investigación.';
const DISCUSION_NUEVO =
  'Quispe y Mamani (2023) hallaron en Puno una relación parecida, y que dos universidades del país ' +
  'muestren lo mismo da más peso a lo encontrado en esta investigación.';

/** Un modelo de mentira: devuelve lo que diga `responder` para cada párrafo. */
function modeloFalso(responder) {
  const llamadas = [];
  const generar = async (peticion) => {
    const mensaje = JSON.parse(peticion.mensajes[0].texto);
    llamadas.push({ sistema: peticion.sistema, mensaje });
    const salida = {};
    for (const [clave, valor] of Object.entries(mensaje.parrafos)) {
      const texto = typeof valor === 'string' ? valor : valor.texto;
      salida[clave] = responder({ clave, texto, nota: valor.nota, pasada: typeof valor !== 'string', mensaje });
    }
    return { texto: JSON.stringify(salida), uso: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  };
  return { generar, llamadas };
}

const REESCRITOS = new Map([
  [METODO, METODO_NUEVO],
  [RESULTADO, RESULTADO_NUEVO],
  [DISCUSION, DISCUSION_NUEVO],
]);

test('cada capítulo va con su ruta y su nombre de sección', async () => {
  const documento = [
    parrafo('CAPÍTULO III: METODOLOGÍA', 1),
    parrafo(METODO),
    parrafo('IV. Resultados', 1),
    parrafo(RESULTADO),
    parrafo('4.4. Discusión de resultados', 2),
    parrafo(DISCUSION),
  ];
  const { generar, llamadas } = modeloFalso(({ texto }) => REESCRITOS.get(texto) ?? texto);

  const { cambios, malos } = await humanizador.humanizar({ parrafos: documento, generar, modelos: ['falso'] });

  assert.equal(malos.length, 0);
  assert.equal(Object.keys(cambios).length, 3);
  const deSeccion = (seccion) => llamadas.find((l) => l.mensaje.seccion === seccion);
  assert.match(deSeccion('metodología').sistema, /RUTA DE ESTA SECCIÓN: metodología/);
  assert.match(deSeccion('resultados').sistema, /RUTA DE ESTA SECCIÓN: resultados/);
  assert.match(deSeccion('discusión').sistema, /RUTA DE ESTA SECCIÓN: discusión/);
  // Los títulos dicen el capítulo, pero no se mandan.
  for (const llamada of llamadas) {
    for (const texto of Object.values(llamada.mensaje.parrafos)) assert.doesNotMatch(String(texto), /^CAPÍTULO/);
  }
});

test('el núcleo y los ejemplos van en cada llamada', async () => {
  const skill = humanizador.leerSkill();
  const sistema = humanizador.sistemaDe(skill, 'resultados', false);
  assert.match(sistema, /EL RELLENO SE BORRA/);
  assert.match(sistema, /EJEMPLOS REALES DE ESTA SECCIÓN/);
  assert.doesNotMatch(sistema, /ATENCIÓN: este párrafo ya se pidió/);
  assert.match(humanizador.sistemaDe(skill, 'resultados', true), /ATENCIÓN: este párrafo ya se pidió/);
});

test('lo que falla dos veces tiene un tercer intento', async () => {
  const documento = [parrafo('Metodología', 1), parrafo(METODO)];
  let veces = 0;
  // Las dos primeras veces cambia una cifra (grave: el motor deja el
  // original); la tercera sale bien.
  const { generar } = modeloFalso(({ texto }) => {
    if (texto !== METODO) return texto;
    veces += 1;
    return veces <= 2 ? METODO_NUEVO.replace('201', '210') : METODO_NUEVO;
  });

  const { cambios, malos } = await humanizador.humanizar({ parrafos: documento, generar, modelos: ['falso'], conPasada: false });

  assert.equal(veces, 3);
  assert.equal(malos.length, 0);
  assert.equal(Object.values(cambios)[0].texto, METODO_NUEVO);
});

test('la pasada quita el relleno aunque solo esté en un párrafo', async () => {
  const conRelleno =
    'Los estudiantes necesitan competencias digitales en un entorno digital que cambia constantemente, ' +
    'y el 54 % de los docentes no recibió capacitación formal en inteligencia artificial (Minedu, 2023).';
  const limpio =
    'El 54 % de los docentes no recibió capacitación formal en inteligencia artificial (Minedu, 2023), ' +
    'así que a los estudiantes les falta quien les enseñe competencias digitales.';
  const original =
    'En el contexto actual, los estudiantes necesitan competencias digitales en un entorno digital que cambia ' +
    'constantemente. Cabe destacar que el 54 % de los docentes no recibió capacitación formal (Minedu, 2023).';
  const documento = [parrafo('Introducción', 1), parrafo(original)];
  const notas = [];
  const { generar } = modeloFalso(({ texto, nota, pasada }) => {
    if (pasada) {
      notas.push(nota);
      return limpio;
    }
    return texto === original ? conRelleno : texto;
  });

  const { cambios } = await humanizador.humanizar({ parrafos: documento, generar, modelos: ['falso'] });

  assert.match(notas[0], /relleno/);
  assert.equal(Object.values(cambios)[0].texto, limpio);
});

test('la pasada no deja pasar una cifra cambiada: se queda lo del paso 1', async () => {
  const original =
    'En el contexto actual, los estudiantes necesitan competencias digitales en un entorno digital que cambia ' +
    'constantemente. Cabe destacar que el 54 % de los docentes no recibió capacitación formal (Minedu, 2023).';
  const conRelleno =
    'Los estudiantes necesitan competencias digitales en un entorno digital que cambia constantemente, ' +
    'y el 54 % de los docentes no recibió capacitación formal en inteligencia artificial (Minedu, 2023).';
  const documento = [parrafo('Introducción', 1), parrafo(original)];
  const { generar } = modeloFalso(({ texto, pasada }) =>
    pasada ? texto.replace('54 %', '45 %').replace(/en un entorno[^,]*,/, '') : texto === original ? conRelleno : texto,
  );

  const { cambios } = await humanizador.humanizar({ parrafos: documento, generar, modelos: ['falso'] });

  assert.equal(Object.values(cambios)[0].texto, conRelleno);
});

test('los títulos de capítulo eligen la ruta', () => {
  const ruta = (texto, nivel = 1) => humanizador.rutaDelTitulo({ texto, nivel, palabras: cuerpo.palabrasDe(texto) });
  assert.equal(ruta('4.4. Discusión de resultados', 2), 'discusion');
  assert.equal(ruta('Marco metodológico'), 'metodologia');
  assert.equal(ruta('CONCLUSIONES', null), 'conclusiones');
  assert.equal(ruta('2.1. Antecedentes', 2), 'introduccion-marco');
  assert.equal(ruta('2.2.1. Calidad preanalítica', 3), null);
  // Un párrafo de prosa no es un título aunque nombre un capítulo.
  assert.equal(ruta('Los resultados se presentan a continuación según cada objetivo del estudio.', null), null);
});

test('«Esa brecha… / Eso repercute… / Ese uso…» cuentan como un solo molde', () => {
  const textos = [
    'El 67 % de las universidades ya usa estas herramientas en sus clases de pregrado y posgrado. Esa adopción pesa en la competitividad de cada institución del país.',
    'Solo el 38 % de los estudiantes de la región tiene competencias digitales avanzadas según la CEPAL. Esa brecha limita el acceso a las oportunidades laborales de muchos jóvenes.',
    'El 54 % de los docentes no recibió capacitación formal en el uso pedagógico de estas herramientas. Eso repercute en la calidad de los aprendizajes de las aulas.',
    'Los estudiantes de la facultad usan estas herramientas de manera intuitiva y sin ninguna orientación. Ese uso puede afectar el pensamiento crítico de cada uno.',
  ].map((texto, i) => ({ clave: String(i), texto }));

  const notas = humanizador.moldesDe(textos);

  assert.ok([...notas.values()].flat().some((nota) => /esa\/ese\/eso/.test(nota)));
  // Las dos primeras apariciones se quedan.
  assert.ok(!notas.has('0') && !notas.has('1'));
});

// ── Párrafos que se parecen entre sí (v3, 22-oct-2026) ────────────────────

const PLANTILLA_A =
  'La adaptación de materiales al ritmo del estudiante supone un cambio significativo para la educación superior, ' +
  'porque también plantea nuevas preguntas sobre qué se aprende, cómo se aprende y quién responde por los resultados.';
const PLANTILLA_B =
  'La asistencia automatizada para organizar borradores supone un cambio significativo para la educación superior, ' +
  'porque también plantea nuevas preguntas sobre qué se aprende, cómo se aprende y quién responde por los resultados.';
const B_DISTINTO =
  'Organizar borradores con asistencia automatizada obliga a decidir quién responde por lo que entrega el estudiante, ' +
  'y esa decisión cambia lo que la universidad entiende por aprender y por evaluar un trabajo escrito.';

test('un párrafo que repite frases de uno anterior se marca; el primero no', () => {
  const repetidos = humanizador.parecidos([
    { clave: 'a', texto: PLANTILLA_A },
    { clave: 'b', texto: PLANTILLA_B },
  ]);
  assert.ok(!repetidos.has('a'));
  assert.equal(repetidos.get('b').parecidoA, 'a');
  assert.ok(repetidos.get('b').repetidas.some((frase) => /nuevas preguntas sobre qué se aprende/.test(frase)));
});

test('párrafos distintos no se marcan', () => {
  const repetidos = humanizador.parecidos([
    { clave: '1', texto: METODO_NUEVO },
    { clave: '2', texto: RESULTADO_NUEVO },
    { clave: '3', texto: DISCUSION_NUEVO },
  ]);
  assert.equal(repetidos.size, 0);
});

test('el que sigue pareciéndose a otro se reescribe viendo las frases repetidas y su gemelo', async () => {
  const documento = [parrafo('Introducción', 1), parrafo(PLANTILLA_A), parrafo(PLANTILLA_B)];
  const vistos = [];
  // El paso 1 devuelve los dos casi iguales (como DeepSeek con una plantilla);
  // la ronda contra la plantilla trae el segundo distinto.
  const { generar } = modeloFalso(({ texto, pasada, mensaje, clave }) => {
    if (!pasada) return texto.replace('supone', 'representa');
    const pedido = mensaje.parrafos[clave];
    if (pedido.repetidas) {
      vistos.push(pedido);
      return B_DISTINTO;
    }
    return texto;
  });

  const { cambios } = await humanizador.humanizar({ parrafos: documento, generar, modelos: ['falso'] });

  assert.equal(vistos.length, 1);
  assert.match(vistos[0].parecido_a, /adaptación de materiales/);
  assert.ok(vistos[0].repetidas.length > 0);
  const textos = Object.values(cambios).map((c) => c.texto);
  assert.ok(textos.includes(B_DISTINTO));
});

test('en el paso 1 se avisa qué párrafos comparten plantilla', async () => {
  const documento = [parrafo('Introducción', 1), parrafo(PLANTILLA_A), parrafo(PLANTILLA_B)];
  const { generar, llamadas } = modeloFalso(({ texto }) => texto.replace('supone', 'representa'));

  await humanizador.humanizar({ parrafos: documento, generar, modelos: ['falso'], conPasada: false });

  assert.equal(llamadas[0].mensaje.comparten_plantilla.length, 2);
});
