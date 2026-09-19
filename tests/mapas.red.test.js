'use strict';

/**
 * Las redes de VOSviewer.
 *
 * Lo que se prueba son las reglas que un asesor puede comprobar a mano con el
 * VOSviewer de escritorio. Los números del recuento fraccionado son los del
 * ejemplo del propio manual (VOSviewer 1.6.20, figuras 7 y 8).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  construirRed,
  clave,
  leerTesauro,
  citasNormalizadas,
} = require('../src/modules/mapas/mapas.red');
const { frasesNominales, relevancia, singular } = require('../src/modules/mapas/mapas.terminos');

const doc = (etiquetas, extra = {}) => ({
  id: extra.id ?? Math.random().toString(36).slice(2),
  anio: extra.anio ?? 2020,
  citas: extra.citas ?? 0,
  referencias: extra.referencias ?? [],
  unidades: etiquetas.map((e) => (typeof e === 'string' ? { etiqueta: e } : e)),
});

const fila = (mapa, etiqueta) => mapa.resumen.filas.find((f) => f.etiqueta === etiqueta);

const enlace = (mapa, a, b) => {
  const id = Object.fromEntries(mapa.vosviewer.network.items.map((i) => [i.label, i.id]));
  const [x, y] = [id[a], id[b]].sort((m, n) => m - n);
  return mapa.vosviewer.network.links.find((l) => l.source_id === x && l.target_id === y)?.strength ?? 0;
};

// ── Coocurrencia y coautoría ────────────────────────────────────────────────

test('las variantes de escritura son la misma unidad', () => {
  assert.equal(clave('Machine-Learning'), clave('machine learning'));
  assert.equal(clave('Educación  Virtual'), clave('educacion virtual'));
  assert.notEqual(clave('network'), clave('networks'));
});

test('recuento completo: cada documento suma uno y una unidad repetida cuenta una vez', () => {
  const mapa = construirRed([doc(['A', 'B', 'a']), doc(['A', 'B', 'C']), doc(['A', 'C']), doc(['B', 'C'])], {
    minimo: 1,
  });
  assert.equal(fila(mapa, 'A').ocurrencias, 3);
  assert.equal(enlace(mapa, 'A', 'B'), 2);
  assert.equal(fila(mapa, 'A').fuerza, 4);
  assert.equal(fila(mapa, 'A').enlaces, 2);
});

test('recuento fraccionado: el ejemplo del manual de VOSviewer', () => {
  // D1: A1, A2, A3 · D2: A1, A3 · D3: A2, A4.
  const documentos = [doc(['A1', 'A2', 'A3']), doc(['A1', 'A3']), doc(['A2', 'A4'])];

  const completo = construirRed(documentos, { minimo: 1, perfil: 'unidades' });
  assert.equal(enlace(completo, 'A1', 'A3'), 2);

  const fraccionado = construirRed(documentos, { minimo: 1, perfil: 'unidades', recuento: 'fraccionado' });
  assert.equal(enlace(fraccionado, 'A1', 'A3'), 1.5);
  assert.equal(enlace(fraccionado, 'A2', 'A4'), 1);
  assert.equal(enlace(fraccionado, 'A1', 'A2'), 0.5);
});

test('se enseña la forma más usada', () => {
  const mapa = construirRed([doc(['Social Media', 'x']), doc(['social media', 'x']), doc(['social media', 'x'])], {
    minimo: 1,
  });
  assert.ok(fila(mapa, 'social media'));
});

test('el umbral deja fuera lo que sale menos veces', () => {
  const mapa = construirRed([doc(['A', 'B', 'raro']), doc(['A', 'B']), doc(['A', 'B'])], { minimo: 2 });
  assert.equal(mapa.resumen.cumplenMinimo, 2);
  assert.equal(fila(mapa, 'raro'), undefined);
});

test('el umbral automático no deja más de lo que cabe', () => {
  const documentos = [];
  for (let i = 0; i < 60; i += 1) documentos.push(doc([`t${i % 20}`, `t${(i + 1) % 20}`, `u${i}`]));
  const mapa = construirRed(documentos, { maximo: 10 });
  assert.equal(mapa.resumen.minimoAutomatico, true);
  assert.ok(mapa.resumen.minimo >= 2);
  assert.ok(mapa.resumen.enElMapa <= 10);
});

test('de lo que pasa el umbral entran las de mayor fuerza total de enlace', () => {
  const documentos = [
    ...Array.from({ length: 5 }, () => doc(['solo', 'z'])),
    doc(['A', 'B', 'C', 'D']),
    doc(['A', 'B', 'C', 'D']),
    doc(['A', 'B', 'C']),
  ];
  const mapa = construirRed(documentos, { minimo: 2, maximo: 5 });
  const etiquetas = mapa.resumen.filas.map((f) => f.etiqueta);
  assert.ok(etiquetas.includes('D'));
  assert.ok(etiquetas.includes('A'));
});

test('el mínimo de citas deja fuera a quien no lo alcanza', () => {
  const documentos = [
    doc(['Ana', 'Beto'], { citas: 50 }),
    doc(['Ana', 'Beto'], { citas: 10 }),
    doc(['Ana', 'Ciro'], { citas: 1 }),
    doc(['Ana', 'Ciro'], { citas: 1 }),
  ];
  const mapa = construirRed(documentos, { minimo: 2, minimoCitas: 5, perfil: 'unidades' });
  assert.ok(fila(mapa, 'Beto'));
  assert.equal(fila(mapa, 'Ciro'), undefined);
  assert.equal(fila(mapa, 'Ana').citas, 62);
});

// ── Citación, acoplamiento y cocitación ─────────────────────────────────────

test('citación: se enlazan quien cita y quien es citado, dentro del conjunto', () => {
  const documentos = [
    doc(['Ana'], { id: 'W1', referencias: ['W2', 'W9'] }),
    doc(['Beto'], { id: 'W2', referencias: [] }),
    doc(['Ciro'], { id: 'W3', referencias: ['W2'] }),
  ];
  const mapa = construirRed(documentos, { enlace: 'citacion', minimo: 1, perfil: 'unidades' });
  assert.equal(enlace(mapa, 'Ana', 'Beto'), 1);
  assert.equal(enlace(mapa, 'Ciro', 'Beto'), 1);
  // W9 no está en el conjunto: no enlaza con nadie.
  assert.equal(enlace(mapa, 'Ana', 'Ciro'), 0);
});

test('acoplamiento: una unidad por referencia compartida, sumando pares de documentos', () => {
  const documentos = [
    doc(['Revista 1'], { id: 'D1', referencias: ['R1', 'R2'] }),
    doc(['Revista 2'], { id: 'D2', referencias: ['R1', 'R2'] }),
    doc(['Revista 2'], { id: 'D3', referencias: ['R1'] }),
  ];
  const mapa = construirRed(documentos, { enlace: 'acoplamiento', minimo: 1, perfil: 'unidades' });
  // D1–D2 comparten 2 y D1–D3 comparten 1: 3 entre las dos revistas.
  assert.equal(enlace(mapa, 'Revista 1', 'Revista 2'), 3);
});

test('acoplamiento de documentos: tantos como referencias en común', () => {
  const documentos = [
    doc([{ clave: 'D1', etiqueta: 'Ana (2020)' }], { id: 'D1', referencias: ['R1', 'R2', 'R3'] }),
    doc([{ clave: 'D2', etiqueta: 'Beto (2021)' }], { id: 'D2', referencias: ['R2', 'R3'] }),
  ];
  const mapa = construirRed(documentos, { enlace: 'acoplamiento', perfil: 'documentos' });
  assert.equal(enlace(mapa, 'Ana (2020)', 'Beto (2021)'), 2);
});

test('citas normalizadas: entre la media del mismo año en el conjunto', () => {
  const norm = citasNormalizadas([
    { anio: 2020, citas: 30 },
    { anio: 2020, citas: 10 },
    { anio: 2023, citas: 2 },
    { anio: 2023, citas: 0 },
    { anio: 2024, citas: 0 },
  ]);
  assert.deepEqual(norm, [1.5, 0.5, 2, 0, 0]);
});

// ── Tesauro, exclusiones, formato ───────────────────────────────────────────

test('el tesauro de VOSviewer: cabecera, tabulador y reemplazo vacío para ignorar', () => {
  const tesauro = leerTesauro('label\treplace by\nai\tartificial intelligence\nstudy\t\nsme = small business');
  assert.equal(tesauro.size, 3);
  assert.equal(tesauro.get('study'), null);

  const mapa = construirRed(
    [doc(['AI', 'education', 'study']), doc(['Artificial Intelligence', 'education', 'study']), doc(['ai', 'education'])],
    { minimo: 1, tesauro: 'label\treplace by\nai\tartificial intelligence\nstudy\t' },
  );
  assert.equal(fila(mapa, 'artificial intelligence').ocurrencias, 3);
  assert.equal(fila(mapa, 'study'), undefined);
});

test('excluir quita por etiqueta, también nombres con coma', () => {
  const mapa = construirRed(
    [doc(['Larcker, D.', 'Fornell, C.', 'Hair, J.']), doc(['Larcker, D.', 'Fornell, C.', 'Hair, J.'])],
    { minimo: 1, excluir: 'Hair, J.', perfil: 'unidades' },
  );
  assert.equal(fila(mapa, 'Hair, J.'), undefined);
  assert.ok(fila(mapa, 'Larcker, D.'));
});

test('las unidades sin enlace no entran al mapa y se cuentan', () => {
  const mapa = construirRed([doc(['A', 'B']), doc(['A', 'B']), doc(['C']), doc(['C'])], { minimo: 2 });
  assert.equal(mapa.resumen.enElMapa, 2);
  assert.equal(mapa.resumen.sinEnlaces, 1);
});

test('el JSON es el de VOSviewer y los archivos map y network dicen lo mismo', () => {
  const mapa = construirRed(
    [doc(['A', 'B'], { anio: 2018, citas: 10 }), doc(['A', 'B'], { anio: 2022, citas: 30 }), doc(['A', 'C']), doc(['B', 'C'])],
    { minimo: 1, perfil: 'unidades', nombreUnidad: ['Autor', 'Autores'] },
  );
  const { network, config } = mapa.vosviewer;

  assert.equal(config.parameters.item_size, 'Documentos');
  assert.equal(config.terminology.item, 'Autor');
  for (const item of network.items) {
    assert.equal(item.x, undefined, 'la disposición la calcula VOSviewer');
    assert.equal(item.cluster, undefined, 'los clústeres los calcula VOSviewer');
  }
  const a = network.items.find((i) => i.label === 'A');
  assert.equal(a.weights.Citas, 40);
  assert.equal(a.scores['Año promedio de publicación'], 2020);

  const filasMapa = mapa.archivos.mapa.split('\n');
  assert.match(filasMapa[0], /^id\tlabel\turl\tweight<Enlaces>\tweight<Fuerza total de enlace>\tweight<Documentos>/);
  assert.equal(filasMapa.length, network.items.length + 1);
  assert.equal(mapa.archivos.red.split('\n').length, network.links.length);
});

test('nada que parezca HTML llega al visor', () => {
  const malo = '<img src=x onerror=alert(1)>';
  const mapa = construirRed([doc([malo, 'B']), doc([malo, 'B'])], { minimo: 1 });
  for (const item of mapa.vosviewer.network.items) assert.doesNotMatch(item.label, /[<>]/);
});

// ── Términos del título y el resumen ────────────────────────────────────────

test('frases nominales como VOSviewer: sin rótulos, sin pronombres, en singular', () => {
  const frases = frasesNominales(
    'Purpose: This study examines teacher burnout and emotional exhaustion among secondary school teachers. We found that low self-efficacy predicted burnout.',
  );
  assert.ok(frases.includes('teacher burnout'));
  assert.ok(frases.includes('emotional exhaustion'));
  assert.ok(frases.includes('secondary school teacher'));
  assert.ok(frases.includes('low self-efficacy'));
  assert.ok(!frases.includes('purpose'));
  assert.ok(!frases.some((f) => /^(this|we)\b/.test(f)));
});

test('singular de los plurales regulares', () => {
  assert.equal(singular('teachers'), 'teacher');
  assert.equal(singular('studies'), 'study');
  assert.equal(singular('analysis'), 'analysis');
  assert.equal(singular('business'), 'business');
});

test('relevancia: un término que sale con todo puntúa menos que uno concentrado', () => {
  const conjuntos = [
    ['general', 'a1', 'a2'],
    ['general', 'a1', 'a2'],
    ['general', 'b1', 'b2'],
    ['general', 'b1', 'b2'],
    ['general', 'c1', 'c2'],
    ['general', 'c1', 'c2'],
  ];
  const r = relevancia(conjuntos);
  assert.ok(r.get('general') < r.get('a1'));
});
