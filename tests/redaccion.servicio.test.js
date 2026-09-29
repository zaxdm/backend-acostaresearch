'use strict';

/**
 * Lo que el servidor hace por la redacción: cambiar párrafos sueltos de un
 * capítulo guardado, cruzar un reporte de Turnitin con los capítulos, la voz
 * del tesista y los avisos al guardar. Sin base ni disco.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

let proyecto = null;
const etapas = [];
sustituir('../src/modules/projects/project.repository', {
  buscar: async () => proyecto,
  guardarEtapa: async (id, code, datos) => {
    etapas.push({ code, ...datos });
    return datos;
  },
});

const textos = new Map();
let voz = null;
let reportes = {};
sustituir('../src/modules/projects/project.storage', {
  palabrasDe: (t) => t.trim().split(/\s+/).length,
  leer: async (id, code) => textos.get(code) ?? null,
  guardar: async (id, code, texto) => {
    textos.set(code, texto);
    return { palabras: texto.trim().split(/\s+/).length };
  },
  leerReporteIaDeDocumento: async () => reportes.ia ?? null,
  leerReporteSimilitud: async () => reportes.similitud ?? null,
  leerVoz: async () => voz,
  guardarVoz: async (id, v) => {
    voz = v;
  },
  leerFichaDeAvance: async () => null,
});

const redaccion = require('../src/modules/projects/redaccion.service');
const { normalizar } = require('../src/modules/projects/project.reporte-ia');

const CAPITULO = [
  '## 2.1 Antecedentes',
  'García [AR11111111:n] estudió a 120 docentes y halló que el liderazgo pesa en la colaboración.',
  '| Tabla | 1 |',
  'Asimismo, cabe destacar que la colaboración juega un papel crucial en el trabajo docente de 2024.',
].join('\n\n');

test.beforeEach(() => {
  proyecto = { id: 'p1', stages: [{ skillCode: 'marco-teorico', palabras: 40, estado: 'EN_CURSO' }] };
  textos.clear();
  textos.set('marco-teorico', CAPITULO);
  etapas.length = 0;
  voz = null;
  reportes = {};
});

test('parte el capítulo en bloques y reconoce títulos y tablas', () => {
  const b = redaccion.bloques(CAPITULO).filter((x) => x.tipo !== 'vacio');
  assert.deepEqual(b.map((x) => [x.n, x.tipo]), [[1, 'titulo'], [2, 'texto'], [3, 'tabla'], [4, 'texto']]);
});

test('el capítulo numerado dice qué bloque no se reescribe', async () => {
  const n = await redaccion.capituloNumerado('u1', 'METODO', 'marco-teorico');
  assert.match(n.lineas[0], /^¶1 \[titulo\] ## 2.1/);
  assert.match(n.lineas[1], /^¶2 García/);
  assert.match(n.lineas[2], /^¶3 \[tabla\]/);
});

test('cambia párrafos sueltos, deja el resto tal cual y rechaza lo que rompe datos o citas', async () => {
  const r = await redaccion.reescribirParrafos({
    userId: 'u1',
    productCode: 'METODO',
    capitulo: 'marco-teorico',
    parrafos: [
      { p: 4, texto: 'En 2024 la colaboración pesaba mucho en el trabajo de los docentes.' },
      { p: 2, texto: 'Con 120 docentes, el liderazgo pesa en la colaboración, según García.' },
      { p: 3, texto: 'Otra tabla.' },
      { p: 4, texto: 'Sin la cifra.' },
    ],
  });
  assert.equal(r.guardados, 1);
  assert.deepEqual(r.rechazados.map((x) => x.p), [2, 3, 4]);
  assert.match(r.rechazados[0].motivo, /AR11111111/);
  assert.match(r.rechazados[1].motivo, /tabla/);
  assert.match(r.rechazados[2].motivo, /2024/);

  const guardado = textos.get('marco-teorico');
  assert.match(guardado, /En 2024 la colaboración pesaba mucho/);
  assert.match(guardado, /García \[AR11111111:n\] estudió/);
  assert.match(guardado, /\| Tabla \| 1 \|/);
  assert.equal(guardado.split('\n\n').length, 4);
  assert.equal(etapas.at(-1).estado, 'EN_CURSO');
});

test('el reporte se cruza con los capítulos guardados y lo reescrito deja de salir', async () => {
  const palabras = (t) => t.split(/\s+/).map(normalizar).filter(Boolean);
  const bloquesDelPdf = redaccion.prosa(CAPITULO).map((b) => palabras(b.texto.replace(/\[AR[^\]]+\]/g, '')));
  reportes.similitud = {
    tipo: 'similitud',
    porcentaje: 30,
    palabras: bloquesDelPdf.flat().join(' '),
    ia: bloquesDelPdf.map((ws, i) => (i === 1 ? '1' : '0').repeat(ws.length)).join(''),
  };

  const antes = await redaccion.loMarcadoEnCapitulos('u1', 'METODO', { tipo: 'similitud' });
  assert.equal(antes.marcados, 1);
  assert.match(antes.lineas[0], /^\[marco-teorico ¶4\] \(100 %\) Asimismo/);

  const saltado = await redaccion.loMarcadoEnCapitulos('u1', 'METODO', { tipo: 'similitud', saltar: ['marco-teorico#4'] });
  assert.equal(saltado.pendientes, 0);

  await redaccion.reescribirParrafos({
    userId: 'u1',
    productCode: 'METODO',
    capitulo: 'marco-teorico',
    parrafos: [{ p: 4, texto: 'En 2024 los docentes daban mucho peso a colaborar entre ellos.' }],
  });
  const despues = await redaccion.loMarcadoEnCapitulos('u1', 'METODO', { tipo: 'similitud' });
  assert.equal(despues.lineas.length, 0);

  assert.deepEqual(await redaccion.loMarcadoEnCapitulos('u1', 'METODO', { tipo: 'ia' }), { sinReporte: true });
});

test('la voz del avance no pisa la del reporte de IA', async () => {
  const largo = Array.from({ length: 70 }, (_, i) => `palabra${i}`).join(' ') + '.';
  await redaccion.recordarVozDelAvance('p1', [largo]);
  assert.equal(voz.origen, 'avance');

  voz = { origen: 'reporte-ia', parrafos: ['suyo'] };
  await redaccion.recordarVozDelAvance('p1', [largo]);
  assert.deepEqual(voz.parrafos, ['suyo']);
});

test('al guardar avisa del vocabulario de modelo y del molde de apertura', async () => {
  const repetido = [1, 2, 3]
    .map((i) => `Asimismo, se presenta el reto número ${i} del estudio con su dato.`)
    .join('\n\n');
  textos.set('marco-teorico', `${CAPITULO}\n\n${repetido}`);
  const avisos = await redaccion.avisosDeRedaccion('u1', 'METODO', 'marco-teorico');
  assert.ok(avisos.some((a) => /Vocabulario de modelo: .*crucial/.test(a)), avisos.join('\n'));
  assert.ok(avisos.some((a) => /3 párrafos abren igual \(«asimismo se…»\)/.test(a)), avisos.join('\n'));
});
