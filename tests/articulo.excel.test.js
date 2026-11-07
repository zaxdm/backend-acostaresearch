'use strict';

/**
 * La Matriz de Estrategia y la trazabilidad de las citas del artículo empírico,
 * en Excel armado por el servidor (E2E del 7-nov-2026: Claude reescribía el
 * script de la skill en claude.ai y el archivo se quedaba en ese chat).
 *
 * Lo que se fija: el .xlsx abre (lo lee el mismo lector que las rúbricas),
 * sale una hoja por título «##» con su tabla, los nombres de hoja son válidos
 * y la trazabilidad lleva cada cita con su frase y su estado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { libro, hojasDeMarkdown, nombresDeHoja, letra } = require('../src/modules/projects/project.libro');
const { textoDeExcel, esExcel } = require('../src/modules/projects/project.hoja');
const verificacion = require('../src/modules/projects/project.verificacion');

const MATRIZ = [
  'Matriz de Estrategia · dependencia-chatgpt',
  '',
  '## 1. Diseño y muestra',
  '| Campo | Contenido |',
  '|---|---|',
  '| Enfoque | Cuantitativo |',
  '| Técnica | PLS-SEM con **bootstrap** |',
  '| Población | Estudiantes de Administración \\| Trujillo |',
  '',
  '## 2. Objetivos',
  '| Objetivo | Pregunta | Hipótesis |',
  '|:--|:--:|--:|',
  '| OE1 | ¿Qué relación hay…? | H1 |',
  '*Nota.* Las hipótesis tienen dirección.',
  '',
  '## 5. Pendientes',
  '- [POR CONFIRMAR: total de matriculados]',
  '- Permiso del autor del AIDep-22',
].join('\n');

test('la Matriz guardada en Markdown sale con una hoja por título y su tabla', () => {
  const hojas = hojasDeMarkdown(MATRIZ);
  assert.deepEqual(
    hojas.map((h) => h.nombre),
    ['Notas', '1. Diseño y muestra', '2. Objetivos', '5. Pendientes'],
  );
  const diseno = hojas[1].filas;
  assert.deepEqual(diseno[0], ['Campo', 'Contenido']);
  assert.deepEqual(diseno[2], ['Técnica', 'PLS-SEM con bootstrap'], 'sin los asteriscos');
  assert.deepEqual(diseno[3], ['Población', 'Estudiantes de Administración | Trujillo'], 'la barra escapada es texto');
  assert.equal(diseno.length, 4, 'la línea separadora no es una fila');

  const objetivos = hojas[2].filas;
  assert.deepEqual(objetivos[1], ['OE1', '¿Qué relación hay…?', 'H1']);
  assert.deepEqual(objetivos.at(-1), ['Nota. Las hipótesis tienen dirección.'], 'la nota va debajo');

  // Sin tabla: una columna con sus líneas, para no perder nada.
  assert.deepEqual(hojas[3].filas, [
    ['5. Pendientes'],
    ['[POR CONFIRMAR: total de matriculados]'],
    ['Permiso del autor del AIDep-22'],
  ]);
});

test('el .xlsx abre y trae lo escrito, con tildes y signos', () => {
  const zip = new AdmZip(libro(hojasDeMarkdown(MATRIZ)));
  assert.ok(esExcel(zip));
  const leido = textoDeExcel(zip);
  assert.match(leido, /\[Hoja\] 1\. Diseño y muestra/);
  assert.match(leido, /Técnica \| PLS-SEM con bootstrap/);
  assert.match(leido, /OE1 \| ¿Qué relación hay…\? \| H1/);
  assert.match(leido, /\[Hoja\] 5\. Pendientes/);
  // La primera fila en negrita (estilo 1) y fija al bajar.
  const hoja = zip.readAsText('xl/worksheets/sheet2.xml');
  assert.match(hoja, /<c r="A1" t="inlineStr" s="1">/);
  assert.match(hoja, /state="frozen"/);
});

test('los nombres de hoja son válidos para Excel y no se repiten', () => {
  const nombres = nombresDeHoja(['Objetivos: general/específicos [v2]', 'Objetivos: general/específicos [v2]', '', 'x'.repeat(40)]);
  for (const n of nombres) {
    assert.ok(n.length <= 31, n);
    assert.doesNotMatch(n, /[[\]:*?/\\]/);
  }
  assert.notEqual(nombres[0].toLowerCase(), nombres[1].toLowerCase());
  assert.equal(nombres[2], 'Hoja 3');
  assert.deepEqual([letra(0), letra(25), letra(26), letra(27)], ['A', 'Z', 'AA', 'AB']);
});

test('un texto sin nada que poner no arma hojas, y el libro vacío igual abre', () => {
  assert.deepEqual(hojasDeMarkdown('   \n\n'), []);
  const zip = new AdmZip(libro([]));
  assert.ok(esExcel(zip));
  assert.match(textoDeExcel(zip), /\(vacía\)/);
});

test('la trazabilidad lleva cada cita con su fuente, su frase y lo que respondió el autor', () => {
  const capitulos = [
    {
      code: 'articulo-fase2-introduccion',
      titulo: 'Introducción',
      texto: 'La dependencia de la IA crece entre universitarios [AR0A1B2C3D]. Otra frase sin cita.',
    },
  ];
  const fuente = {
    ref: 'AR0A1B2C3D',
    authors: 'Wang, L., & Li, M.',
    year: 2026,
    title: 'AI dependence and critical thinking',
    source: 'Nurse Education Today',
    doi: '10.1016/j.nedt.2026.1',
  };
  const items = verificacion.inventario(capitulos, new Map([['AR0A1B2C3D', fuente]]), {});
  const [traza, resumen] = verificacion.hojasDeTrazabilidad(items);

  assert.equal(traza.nombre, 'Trazabilidad');
  assert.equal(traza.filas.length, 2);
  const fila = traza.filas[1];
  assert.equal(fila[0], 'Introducción');
  assert.equal(fila[1], 'AR0A1B2C3D');
  assert.equal(fila[6], 'https://doi.org/10.1016/j.nedt.2026.1');
  assert.match(fila[7], /La dependencia de la IA crece/);
  assert.equal(fila[9], 'sin verificar');

  assert.deepEqual(resumen.filas.at(-1), ['Total (fuente por sección)', '1']);

  const zip = new AdmZip(libro([traza, resumen]));
  assert.match(textoDeExcel(zip), /AR0A1B2C3D \| Wang, L\., & Li, M\. \| 2026/);
});

test('una cita dentro de una tabla de la Matriz sale sin las barras de la tabla', () => {
  const items = verificacion.inventario(
    [
      {
        code: 'articulo-fase1-matriz-de-estrategia',
        titulo: 'Fase 1 — Matriz',
        texto: '| Campo | Contenido |\n|---|---|\n| Tamaño de muestra | 275, según Kock y Hadaya [AR0A1B2C3D] |',
      },
    ],
    new Map([['AR0A1B2C3D', { ref: 'AR0A1B2C3D', authors: 'Kock, N.', year: 2016, title: 'Minimum sample size' }]]),
    {},
  );
  const [traza] = verificacion.hojasDeTrazabilidad(items);
  const frase = traza.filas[1][7];
  assert.doesNotMatch(frase, /^\||\|$/);
  assert.match(frase, /Tamaño de muestra · 275, según Kock y Hadaya/);
});
