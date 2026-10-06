'use strict';

/**
 * El reporte de IA de Turnitin: cómo se reconocen sus resaltados en el PDF y
 * cómo se cruzan sus palabras con los párrafos del Word.
 *
 * El PDF de verdad no se guarda en el repositorio (es la tesis de un cliente):
 * aquí se prueba con la lista de operaciones que devuelve pdfjs, que es lo que
 * lee `resaltados`, y con reportes ya leídos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('../src/modules/projects/project.reporte-ia');
const controles = require('../src/modules/projects/project.humanizado-controles');

const OPS = { save: 10, restore: 11, transform: 12, setFillRGBColor: 59, constructPath: 91 };

test('reconoce el celeste de Turnitin y el morado del parafraseado, no el negro ni el amarillo', () => {
  assert.equal(r.esColorDeIa('#52c6da'), true);
  assert.equal(r.esColorDeIa('#a37cf0'), true);
  for (const otro of ['#000000', '#ffff00', '#4472c4', '#ff0000', '#191919', 'x']) {
    assert.equal(r.esColorDeIa(otro), false, otro);
  }
});

test('la caja del resaltado sale en coordenadas de la página, y la del texto amarillo no cuenta', () => {
  const fn = [
    OPS.save, OPS.setFillRGBColor, OPS.transform, OPS.constructPath, OPS.restore,
    OPS.save, OPS.setFillRGBColor, OPS.constructPath, OPS.restore,
  ];
  const args = [
    null, ['#52c6da'], [1, 0, 0, 1, 91.9, 758.3], [22, [], new Float32Array([0, 0, 460.75, 10.5])], null,
    null, ['#ffff00'], [22, [], [0, 0, 100, 10]], null,
  ];
  const cajas = r.resaltados(fn, args, OPS);
  assert.equal(cajas.length, 1);
  assert.deepEqual(cajas[0].map((n) => Math.round(n)), [92, 758, 553, 769]);
});

test('las palabras de un renglón se sitúan por su posición, sin cabeceras de Turnitin', () => {
  const palabras = r.palabrasDelRenglon({ str: 'uno dos', transform: [11, 0, 0, 11, 100, 700], width: 70 });
  assert.deepEqual(palabras.map((p) => p.texto), ['uno', 'dos']);
  assert.ok(palabras[0].x < palabras[1].x);
  const cabecera = { str: 'Página 3 de 40 - Entrega de escritura con IA', transform: [11, 0, 0, 11, 0, 0], width: 200 };
  assert.deepEqual(r.palabrasDelRenglon(cabecera), []);
});

test('lee el porcentaje de la portada, también el «*%» de menos del 20 %', () => {
  assert.equal(r.porcentajeDe('Portada 86 % detectado como IA El porcentaje'), 86);
  assert.equal(r.porcentajeDe('*% detectado como IA'), null);
  assert.equal(r.porcentajeDe('12% detected as AI'), 12);
  assert.equal(r.porcentajeDe('Reporte de similitud 25%'), undefined);
});

test('cruza el reporte con el Word aunque el PDF traiga cabeceras de por medio', () => {
  const parrafos = [
    { id: 1, texto: 'La autora escribió este párrafo sin ayuda y quedó limpio del todo.' },
    { id: 2, texto: 'El verdadero desafío dogmático estriba en la imperiosa necesidad de equilibrar la tutela.' },
    { id: 3, texto: 'Un párrafo añadido después que Turnitin nunca vio.' },
  ];
  const limpia = (t) => t.split(/\s+/).map(r.normalizar);
  const p1 = limpia(parrafos[0].texto);
  const p2 = limpia(parrafos[1].texto);
  const ruido = ['página', '3', 'de', '40'];
  const reporte = {
    palabras: [...p1, ...ruido, ...p2].join(' '),
    ia: '0'.repeat(p1.length + ruido.length) + '1'.repeat(p2.length),
  };
  const cruce = r.cruzar(reporte, parrafos);
  assert.deepEqual(cruce.get(1), { porcentaje: 0, marcado: false });
  assert.deepEqual(cruce.get(2), { porcentaje: 100, marcado: true });
  assert.deepEqual(cruce.get(3), { porcentaje: null, marcado: false });
});

test('un PDF que no se puede abrir se rechaza con un motivo que se entiende', async () => {
  assert.equal(r.esPdf(Buffer.from('%PDF-1.7 ...')), true);
  assert.equal(r.esPdf(Buffer.from('PK\u0003\u0004')), false);
  await assert.rejects(() => r.leer(Buffer.from('%PDF-roto')), r.ReporteNoValido);
});

test('los controles avisan de oraciones iguales, vocabulario de modelo y rayas, sin rechazar', () => {
  const avisos = controles.avisosDelParrafo(
    7,
    'La norma exige filtros. El juez decide rápido.',
    'La norma exige filtros. Resulta indispensable, en estrecha relación, que el juez — con calma — decida.',
  );
  assert.equal(avisos.length, 3, avisos.join('\n'));
  assert.match(avisos[0], /1 de 2 oraciones/);
  assert.match(avisos[1], /resulta indispensable/);
  assert.match(avisos[2], /rayas/);
  assert.deepEqual(controles.oraciones('Ruiz et al. (2022) lo dice. Fin.'), ['Ruiz et al. (2022) lo dice.', 'Fin.']);
});

test('las muletillas se cuentan sobre todo lo humanizado, no por tanda', () => {
  const tanda = (n) => Array.from({ length: n }, (_, i) => `Párrafo ${i}: vale decir que el juez decide.`);
  assert.deepEqual(controles.muletillas(tanda(2)), []);
  const muchas = controles.muletillas(tanda(6));
  assert.equal(muchas[0].frase, 'vale decir que');
  assert.equal(muchas[0].veces, 6);
});

// ── El reporte clásico y el recibo (6-oct-2026) ─────────────────────────────

test('el reporte clásico de Turnitin («Informe de originalidad») es de similitud, aunque venga en renglones', () => {
  const portada = 'INFORME DE ORIGINALIDAD\n25%\nÍNDICE DE\nSIMILITUD\n24%\nFUENTES DE INTERNET\n5%\nPUBLICACIONES';
  assert.equal(r.tipoDe(portada), 'similitud');
  assert.equal(r.cabeceraDeSimilitud(portada).porcentaje, 25);
  assert.equal(r.tipoDe('ORIGINALITY REPORT 12% SIMILARITY INDEX'), 'similitud');
});

test('el recibo digital de la entrega se reconoce y no pasa por reporte', () => {
  const recibo = 'Recibo digital\nEste recibo confirma que Turnitin recibió su trabajo. A continuación podrá ver la información';
  assert.equal(r.tipoDe(recibo), null);
  assert.equal(r.esRecibo(recibo), true);
  assert.equal(r.esRecibo('Capítulo I. El problema'), false);
});
