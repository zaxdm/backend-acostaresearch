'use strict';

/**
 * Las piezas de la skill del servidor (`preparar.piezas`, 24-oct-2026): se
 * cargan todas, cada tanda recibe solo las que le tocan y el presupuesto no se
 * pasa.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const piezas = require('../src/modules/preparar/preparar.piezas');
const humanizador = require('../src/modules/preparar/preparar.humanizar');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');

const CARPETA = path.join(__dirname, '../src/modules/preparar/humanizador/piezas');
const parrafo = (texto, titulo = '') => ({ texto, titulo, palabras: cuerpo.palabrasDe(texto) });

test('se cargan todas las piezas de cada carpeta, y ninguna pasa de 2 500 caracteres', () => {
  const cargadas = piezas.leerPiezas(CARPETA);
  const enDisco = fs
    .readdirSync(CARPETA, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(CARPETA, d.name)).map((f) => `${d.name}/${f}`));
  assert.equal(cargadas.length, enDisco.length, 'una pieza del disco no tiene condición y no se carga nunca');
  for (const pieza of cargadas) assert.ok(pieza.texto.length <= 2500, `${pieza.ruta}: ${pieza.texto.length} caracteres`);
  assert.equal(cargadas.filter((p) => p.siempre).length, 4);
  assert.equal(cargadas.filter((p) => p.pasada).length, 1);
});

test('el texto de una pieza no lleva su línea de condición', () => {
  for (const pieza of piezas.leerPiezas(CARPETA)) {
    assert.ok(!/^(CUANDO|TRABAJO):/m.test(pieza.texto), pieza.ruta);
  }
});

test('las piezas de capítulo se eligen por el título de la sección', () => {
  const lista = piezas.leerPiezas(CARPETA);
  const texto = 'Los resultados que se obtuvieron fueron favorables para el grupo evaluado en la institución.';
  const enAntecedentes = piezas.elegir(lista, [parrafo(texto, '2.1 Antecedentes')]);
  const enOtraParte = piezas.elegir(lista, [parrafo(texto, '3.4 Aspectos éticos')]);
  assert.ok(enAntecedentes.nombres.includes('tesis-05-antecedentes'));
  assert.ok(!enOtraParte.nombres.includes('tesis-05-antecedentes'));
  assert.ok(enOtraParte.nombres.includes('tesis-13-etica'));
});

test('las piezas de situación se eligen por lo que trae el párrafo', () => {
  const lista = piezas.leerPiezas(CARPETA);
  const hipotesis = parrafo('Como p = 0,003 y rho = 0,61, se rechazó la hipótesis nula y se aceptó la alterna del estudio.');
  const llano = parrafo('Los docentes revisan el material antes de cada sesión con sus grupos de trabajo semanales.');
  assert.ok(piezas.elegir(lista, [hipotesis]).nombres.includes('veredicto-hipotesis'));
  assert.ok(!piezas.elegir(lista, [llano]).nombres.includes('veredicto-hipotesis'));
});

test('la pieza de metodología en futuro entra con dos oraciones «se + futuro» y no con una en pasado', () => {
  const lista = piezas.leerPiezas(CARPETA);
  const proyecto = parrafo('La información se organizará por trabajador en el almacén. Después se establecerá cuántas personas cumplen los requisitos.');
  const tesis = parrafo('La información se organizó por trabajador en el almacén. Después se estableció cuántas personas cumplían los requisitos.');
  assert.ok(piezas.elegir(lista, [proyecto]).nombres.includes('metodologia-en-futuro'));
  assert.ok(!piezas.elegir(lista, [tesis]).nombres.includes('metodologia-en-futuro'));
});

test('las cuatro piezas «siempre» van en toda tanda', () => {
  const lista = piezas.leerPiezas(CARPETA);
  const { nombres } = piezas.elegir(lista, [parrafo('Un párrafo cualquiera que no activa ninguna pieza concreta del servicio.')]);
  for (const siempre of ['general', '00-siempre-revisar-lo-que-metiste', 'registro-que-dio-0', 'errores-al-reordenar']) {
    assert.ok(nombres.includes(siempre), siempre);
  }
});

test('las piezas de informe, TSP, artículo y revisión solo entran en ese tipo de trabajo', () => {
  const lista = piezas.leerPiezas(CARPETA);
  const p = parrafo('Se aplicó la estrategia y se midieron los resultados en la empresa.', 'Hallazgos');
  const sinTipo = piezas.elegir(lista, [p], new Set());
  const informe = piezas.elegir(lista, [p], new Set(['informe']));
  assert.ok(!sinTipo.nombres.includes('informe-02-hallazgos-empresa'));
  assert.ok(informe.nombres.includes('informe-02-hallazgos-empresa'));
});

test('el tipo de trabajo sale de la portada, y la revisión de todo el texto', () => {
  const tsp = [parrafo('Trabajo de suficiencia profesional para optar el título de contador')];
  assert.ok(piezas.tipoDeTrabajo(tsp).has('tsp'));
  const revision = [parrafo('Introducción'), ...Array(70).fill(parrafo('texto')), parrafo('Se siguió la guía PRISMA 2020.')];
  assert.ok(piezas.tipoDeTrabajo(revision).has('revision'));
  assert.equal(piezas.tipoDeTrabajo([parrafo('Tesis para optar el título de licenciado')]).size, 0);
});

test('las piezas de situación no pasan del presupuesto', () => {
  const lista = piezas.leerPiezas(CARPETA);
  const todo = parrafo(
    'Según Pérez (2020), el diseño no experimental de la población y la muestra se relaciona con el instrumento; ' +
      'primero se aplicó, luego se analizó y finalmente se rechazó la hipótesis nula con p < 0,05 en el artículo 5 de la Ley N.° 29733.',
    'Metodología',
  );
  const { texto, nombres } = piezas.elegir(lista, [todo, todo, todo], new Set(['informe', 'articulo', 'revision', 'tsp']), 6000);
  const siempre = lista.filter((p) => p.siempre).reduce((a, p) => a + p.texto.length, 0);
  const demas = lista.filter((p) => nombres.includes(p.nombre) && !p.siempre).reduce((a, p) => a + p.texto.length, 0);
  assert.ok(demas <= 6000, `${demas} caracteres de situación`);
  assert.ok(texto.length > siempre);
});

test('sin piezas, la tanda va como antes', () => {
  assert.deepEqual(piezas.elegir([], [parrafo('x')]), { texto: '', nombres: [] });
  assert.deepEqual(piezas.elegir(undefined, [parrafo('x')]), { texto: '', nombres: [] });
});

test('el sistema de una tanda lleva el núcleo, la ruta, las piezas y el formato, en ese orden', () => {
  const skill = humanizador.leerSkill();
  const { texto } = piezas.elegir(skill.piezas, [parrafo('Un párrafo cualquiera sin nada especial en su redacción.')]);
  const sistema = humanizador.sistemaDe(skill, 'metodologia', false, texto);
  const orden = [skill.nucleo, skill.rutas.metodologia, 'REGLAS QUE APLICAN A ESTA TANDA', 'ENTRADA:'].map((s) => sistema.indexOf(s));
  assert.ok(orden.every((i) => i >= 0), JSON.stringify(orden));
  assert.deepEqual([...orden].sort((a, b) => a - b), orden);
});

test('la pasada lleva la pieza de segunda pasada', () => {
  assert.match(piezas.paraLaPasada(humanizador.leerSkill().piezas), /Cambia solo lo señalado/);
});
