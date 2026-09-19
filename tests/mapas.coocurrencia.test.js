'use strict';

/**
 * El mapa de coocurrencia para VOSviewer.
 *
 * Lo que se prueba son las reglas que un asesor puede comprobar a mano con el
 * VOSviewer de escritorio: recuento completo, umbral de ocurrencias, selección
 * por fuerza total de enlace, y que los archivos `map` y `network` digan lo
 * mismo que el JSON.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { construirMapa, clave, leerSinonimos } = require('../src/modules/mapas/mapas.coocurrencia');

const doc = (terminos, anio = 2020, citas = 0) => ({ terminos, anio, citas });

const porEtiqueta = (mapa) =>
  Object.fromEntries(mapa.resumen.terminos.map((t) => [t.termino, t]));

const enlace = (mapa, a, b) => {
  const id = Object.fromEntries(mapa.vosviewer.network.items.map((i) => [i.label, i.id]));
  const [x, y] = [id[a], id[b]].sort((m, n) => m - n);
  return mapa.vosviewer.network.links.find((l) => l.source_id === x && l.target_id === y)?.strength ?? 0;
};

test('las variantes de escritura son el mismo término', () => {
  assert.equal(clave('Machine-Learning'), clave('machine learning'));
  assert.equal(clave('Educación  Virtual'), clave('educacion virtual'));
  assert.notEqual(clave('network'), clave('networks'));
});

test('recuento completo: cada documento suma uno al enlace y un término repetido cuenta una vez', () => {
  const mapa = construirMapa(
    [
      doc(['A', 'B', 'a']),
      doc(['A', 'B', 'C']),
      doc(['A', 'C']),
      doc(['B', 'C']),
    ],
    { minimo: 1 },
  );

  const t = porEtiqueta(mapa);
  assert.equal(t.A.ocurrencias, 3);
  assert.equal(enlace(mapa, 'A', 'B'), 2);
  assert.equal(enlace(mapa, 'A', 'C'), 2);
  assert.equal(enlace(mapa, 'B', 'C'), 2);
  // Fuerza total de A = 2 (con B) + 2 (con C).
  assert.equal(t.A.fuerza, 4);
  assert.equal(t.A.enlaces, 2);
});

test('se enseña la forma más usada del término', () => {
  const mapa = construirMapa(
    [doc(['Social Media', 'x']), doc(['social media', 'x']), doc(['social media', 'x'])],
    { minimo: 1 },
  );
  assert.ok(porEtiqueta(mapa)['social media']);
});

test('el umbral deja fuera lo que sale menos veces', () => {
  const mapa = construirMapa(
    [doc(['A', 'B', 'raro']), doc(['A', 'B']), doc(['A', 'B'])],
    { minimo: 2 },
  );
  assert.equal(mapa.resumen.cumplenMinimo, 2);
  assert.equal(porEtiqueta(mapa).raro, undefined);
});

test('el umbral automático no deja pasar más términos de los que caben', () => {
  const documentos = [];
  for (let i = 0; i < 30; i += 1) documentos.push(doc([`t${i % 10}`, `t${(i + 1) % 10}`, `u${i}`]));
  const mapa = construirMapa(documentos, { maximo: 10 });
  assert.equal(mapa.resumen.minimoAutomatico, true);
  assert.ok(mapa.resumen.minimo >= 2);
  assert.ok(mapa.resumen.enElMapa <= 10);
});

test('de los que pasan el umbral, entran los de mayor fuerza total de enlace', () => {
  // «solo» sale en cinco documentos pero nunca con los demás del grupo;
  // «D» sale menos pero enlazado con todos.
  const documentos = [
    ...Array.from({ length: 5 }, () => doc(['solo', 'z'])),
    doc(['A', 'B', 'C', 'D']),
    doc(['A', 'B', 'C', 'D']),
    doc(['A', 'B', 'C']),
  ];
  const mapa = construirMapa(documentos, { minimo: 2, maximo: 5 });
  const etiquetas = mapa.resumen.terminos.map((t) => t.termino);
  assert.ok(etiquetas.includes('D'));
  assert.ok(etiquetas.includes('A'));
});

test('sinónimos y excluidos', () => {
  const sinonimos = 'AI = artificial intelligence\nlínea sin forma';
  assert.equal(leerSinonimos(sinonimos).size, 1);

  const mapa = construirMapa(
    [doc(['AI', 'education', 'covid-19']), doc(['Artificial Intelligence', 'education']), doc(['ai', 'education'])],
    { minimo: 1, sinonimos, excluir: 'COVID 19' },
  );
  const t = porEtiqueta(mapa);
  assert.equal(t['artificial intelligence'].ocurrencias, 3);
  assert.equal(t.AI, undefined);
  assert.equal(t['covid-19'], undefined);
});

test('los términos sin ningún enlace no entran al mapa y se cuentan', () => {
  const mapa = construirMapa([doc(['A', 'B']), doc(['A', 'B']), doc(['C']), doc(['C'])], { minimo: 2 });
  assert.equal(mapa.resumen.enElMapa, 2);
  assert.equal(mapa.resumen.sinEnlaces, 1);
});

test('el JSON es el formato de VOSviewer y los archivos dicen lo mismo', () => {
  const mapa = construirMapa(
    [doc(['A', 'B'], 2018, 10), doc(['A', 'B'], 2022, 30), doc(['A', 'C'], 2020, 5), doc(['B', 'C'], 2020, 0)],
    { minimo: 1 },
  );
  const { network, config } = mapa.vosviewer;

  assert.equal(config.parameters.item_size, 'Ocurrencias');
  for (const item of network.items) {
    assert.equal(typeof item.id, 'number');
    assert.equal(item.x, undefined, 'la disposición la calcula VOSviewer');
    assert.equal(item.cluster, undefined, 'los clústeres los calcula VOSviewer');
  }

  const a = network.items.find((i) => i.label === 'A');
  assert.equal(a.scores['Año promedio de publicación'], (2018 + 2022 + 2020) / 3);
  assert.equal(a.scores['Citas promedio'], 15);

  const filasMapa = mapa.archivos.mapa.split('\n');
  assert.match(filasMapa[0], /^id\tlabel\tweight<Enlaces>\tweight<Fuerza total de enlace>\tweight<Ocurrencias>\tscore</);
  assert.equal(filasMapa.length, network.items.length + 1);
  assert.equal(mapa.archivos.red.split('\n').length, network.links.length);
});

test('nada que parezca HTML llega al visor', () => {
  const mapa = construirMapa([doc(['<img src=x onerror=alert(1)>', 'B']), doc(['<img src=x onerror=alert(1)>', 'B'])], {
    minimo: 1,
  });
  for (const item of mapa.vosviewer.network.items) assert.doesNotMatch(item.label, /[<>]/);
});
