'use strict';

/**
 * El testigo entre capítulos.
 *
 * Lo que se prueba es lo que de verdad cambia para el tesista: que un capítulo
 * no arranque sin lo que necesita del anterior, y que corregir un campo no
 * borre los demás. Lo segundo pasa en mitad de una conversación y nadie lo ve.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const etapas = require('../src/modules/projects/project.etapas');

test('solo se guardan los campos declarados de ese capítulo', () => {
  const limpio = etapas.limpiar('tema-y-delimitacion', {
    tema: 'Deserción en primer ciclo',
    poblacion: 'Estudiantes de universidades públicas de Lima',
    inventado: 'esto no existe',
  });

  assert.deepEqual(Object.keys(limpio).sort(), ['poblacion', 'tema']);
});

test('un campo inventado no tumba lo demás', () => {
  // Se llama en mitad de una conversación: rechazar la llamada entera por un
  // extra haría perder también lo bueno.
  const limpio = etapas.limpiar('tema-y-delimitacion', { tema: 'Un tema', color: 'azul' });

  assert.equal(limpio.tema, 'Un tema');
});

test('un capítulo sin campos declarados no guarda nada estructurado', () => {
  assert.equal(etapas.limpiar('discusion', { loQueSea: 'x' }), null);
});

test('las listas se limpian: se quitan los vacíos y se recortan', () => {
  const limpio = etapas.limpiar('problema-y-objetivos', {
    objetivosEspecificos: ['Identificar factores', '   ', '', 'Medir la incidencia'],
  });

  assert.deepEqual(limpio.objetivosEspecificos, ['Identificar factores', 'Medir la incidencia']);
});

test('un valor suelto donde se esperaba lista se acepta igual', () => {
  // El asistente manda a veces un texto donde el campo es lista. Rechazarlo
  // perdería el dato por una cuestión de forma.
  const limpio = etapas.limpiar('problema-y-objetivos', { hipotesis: 'Una sola hipótesis' });

  assert.deepEqual(limpio.hipotesis, ['Una sola hipótesis']);
});

test('una lista larguísima se corta en vez de guardarse entera', () => {
  const muchos = Array.from({ length: 30 }, (_, i) => `Objetivo ${i}`);
  const limpio = etapas.limpiar('problema-y-objetivos', { objetivosEspecificos: muchos });

  assert.equal(limpio.objetivosEspecificos.length, etapas.MAXIMO_POR_LISTA);
});

test('corregir un campo no borra los demás', () => {
  const antes = { problemaGeneral: '¿Qué factores explican la deserción?', objetivoGeneral: 'Determinar…' };
  const despues = etapas.fusionar(antes, { objetivoGeneral: 'Analizar…' });

  assert.equal(despues.problemaGeneral, '¿Qué factores explican la deserción?');
  assert.equal(despues.objetivoGeneral, 'Analizar…');
});

test('avisa de lo que falta del capítulo anterior', () => {
  const porEtapa = new Map([['tema-y-delimitacion', { tema: 'Un tema' }]]);
  const faltan = etapas.queFalta('problema-y-objetivos', porEtapa);

  assert.deepEqual(faltan, ['Población']);
});

test('con todo puesto, no avisa de nada', () => {
  const porEtapa = new Map([
    ['tema-y-delimitacion', { tema: 'Un tema', poblacion: 'Estudiantes de primer ciclo' }],
  ]);

  assert.deepEqual(etapas.queFalta('problema-y-objetivos', porEtapa), []);
});

test('sin nada guardado, avisa de los dos requisitos', () => {
  assert.deepEqual(etapas.queFalta('problema-y-objetivos', new Map()), ['Tema delimitado', 'Población']);
});

test('un capítulo sin requisitos declarados nunca avisa', () => {
  // No se inventan requisitos donde no se han declarado: el orden del método es
  // una recomendación, y un tesista que salte porque su asesor se lo pidió no
  // está haciéndolo mal.
  assert.deepEqual(etapas.queFalta('marco-teorico', new Map()), []);
  assert.deepEqual(etapas.queFalta('tema-y-delimitacion', new Map()), []);
});

test('una lista vacía cuenta como no puesta', () => {
  const porEtapa = new Map([['tema-y-delimitacion', { tema: 'Un tema', poblacion: '' }]]);

  assert.deepEqual(etapas.queFalta('problema-y-objetivos', porEtapa), ['Población']);
});

test('los campos se ven con su nombre de verdad, no con la clave interna', () => {
  const lineas = etapas.comoTexto('problema-y-objetivos', {
    objetivoGeneral: 'Determinar los factores',
    objetivosEspecificos: ['Uno', 'Dos'],
  });

  const texto = lineas.join('\n');
  assert.match(texto, /Objetivo general: Determinar los factores/);
  assert.match(texto, /1\. Uno/);
  assert.match(texto, /2\. Dos/);
  assert.ok(!texto.includes('objetivosEspecificos'), 'la clave interna no se enseña');
});

// ── Las cifras del análisis: se suman, caben y lo que no cabe se dice ─────────
//
// Visto en uso real: un asistente mandó 37 cifras y se guardaron 8 sin avisar;
// al mandar 8 más, borraron las 8 anteriores. Y la herramienta le decía «si vas
// a escribir un número que falte, guárdalo antes».

const CAP_RESULTADOS = 'analisis-datos-rstudio';
const unasCifras = (n, desde = 0) =>
  Array.from({ length: n }, (_, i) => `cifra ${desde + i} = 0.${100 + desde + i}`);

test('las 37 cifras de un análisis caben enteras', () => {
  const r = etapas.acumular(CAP_RESULTADOS, 'resultados', [], unasCifras(37));

  assert.equal(r.lista.length, 37);
  assert.equal(r.nuevas, 37);
  assert.deepEqual(r.fuera, []);
});

test('las cifras que llegan después se SUMAN a las que había', () => {
  const primera = etapas.acumular(CAP_RESULTADOS, 'resultados', [], unasCifras(37));
  const segunda = etapas.acumular(CAP_RESULTADOS, 'resultados', primera.lista, unasCifras(8, 37));

  assert.equal(segunda.lista.length, 45);
  assert.equal(segunda.lista[0], 'cifra 0 = 0.100', 'la primera sigue ahí');
});

test('una cifra repetida no se guarda dos veces, aunque cambien espacios o mayúsculas', () => {
  const r = etapas.acumular(CAP_RESULTADOS, 'resultados', ['r = 0.5112'], ['R  =  0.5112', 'p = 0.0003']);

  assert.deepEqual(r.lista, ['r = 0.5112', 'p = 0.0003']);
  assert.equal(r.repetidas, 1);
  assert.equal(r.nuevas, 1);
});

test('lo que no cabe NO se tira callado: vuelve en «fuera»', () => {
  const llenas = unasCifras(etapas.MAXIMO_CIFRAS);
  const r = etapas.acumular(CAP_RESULTADOS, 'resultados', llenas, ['d = -0.419', 'd = -0.436']);

  assert.equal(r.lista.length, etapas.MAXIMO_CIFRAS);
  assert.deepEqual(r.fuera, ['d = -0.419', 'd = -0.436']);
});

test('reemplazar empieza de cero y dice cuántas había', () => {
  const r = etapas.acumular(CAP_RESULTADOS, 'resultados', unasCifras(8), ['r = 0.5112'], {
    reemplazar: true,
  });

  assert.deepEqual(r.lista, ['r = 0.5112']);
  assert.equal(r.sustituidas, 8);
});

test('los objetivos siguen con su máximo de ocho: el de las cifras es solo suyo', () => {
  const muchos = Array.from({ length: 30 }, (_, i) => `Objetivo ${i}`);

  assert.equal(
    etapas.limpiar('problema-y-objetivos', { objetivosEspecificos: muchos }).objetivosEspecificos.length,
    8,
  );
  assert.equal(etapas.limpiar(CAP_RESULTADOS, { resultados: unasCifras(37) }).resultados.length, 37);
});

test('el capítulo de resultados del artículo guarda cifras y no pide requisitos', () => {
  // No estaba registrado: en un artículo no se guardaba ninguna cifra, y pedir
  // sus requisitos tampoco podía hacerse sin declarar «necesita».
  const limpio = etapas.limpiar('articulo-fase5-resultados', { resultados: ['r = 0.51'] });

  assert.deepEqual(limpio.resultados, ['r = 0.51']);
  assert.deepEqual(etapas.queFalta('articulo-fase5-resultados', new Map()), []);
});
