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
