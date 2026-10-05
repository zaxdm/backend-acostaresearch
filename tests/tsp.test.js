'use strict';

/**
 * El Trabajo de Suficiencia Profesional (TSP): un producto aparte, con sus
 * propias fases `tsp-fase*`, que el servidor trata como una tesis sin
 * hipótesis. Lo que se vigila aquí es lo que el código decide por la clave de
 * la fase; el resto lo deciden sus skills.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { perfilDe, esTesisDelMetodo, TESIS } = require('../src/modules/productos/producto.perfil');
const esquema = require('../src/modules/projects/project.esquema');
const etapas = require('../src/modules/projects/project.etapas');
const { faseDelTitulo } = require('../src/modules/projects/project.avance');

const CATALOGO_TSP = [
  { code: 'tsp-fase0-experiencia', displayName: '0 · Tu experiencia y la empresa' },
  { code: 'tsp-fase1-introduccion', displayName: '1 · Capítulo I · Introducción' },
  { code: 'tsp-fase2-marco-teorico', displayName: '2 · Capítulo II · Marco teórico' },
  { code: 'tsp-fase3-experiencia', displayName: '3 · Capítulo III · Descripción de la experiencia' },
  { code: 'tsp-fase4-resultados', displayName: '4 · Capítulo IV · Resultados' },
  { code: 'tsp-fase5-conclusiones', displayName: '5 · Capítulo V · Conclusiones y recomendaciones' },
];
const CODIGOS = CATALOGO_TSP.map((s) => s.code);

test('lo que empieza por TSP es suficiencia profesional, con el tipo de una tesis', () => {
  const tsp = perfilDe('TSP_SUFICIENCIA_PROFESIONAL');
  assert.equal(tsp.tipo, 'tesis');
  assert.equal(tsp.modalidad, 'tsp');
  assert.equal(tsp.tuObra, 'tu trabajo de suficiencia profesional');
  assert.equal(tsp.entregarla, 'entregarlo');
  assert.equal(tsp.revision, 'revisar_la_tesis');
});

test('el perfil de tesis no se toca, y solo él es «tesis del método»', () => {
  assert.equal(TESIS.modalidad, undefined);
  assert.equal(perfilDe('METODO_9_SKILLS').obra, 'su tesis');
  assert.equal(esTesisDelMetodo('METODO_9_SKILLS'), true);
  assert.equal(esTesisDelMetodo('TSP_SUFICIENCIA_PROFESIONAL'), false);
  assert.equal(esTesisDelMetodo('ARTICULO_SCIENTIFICOS'), false);
});

test('la ficha de la experiencia no sale en el Word, como la propuesta de tema', () => {
  const { capitulos } = esquema.capitulosDelDocumento({
    esquema: null,
    catalogo: CATALOGO_TSP,
    conTexto: new Set(CODIGOS),
  });
  const partes = capitulos.flatMap((c) => c.partes);
  assert.ok(!partes.includes('tsp-fase0-experiencia'));
  assert.deepEqual(partes, CODIGOS.slice(1));
});

test('y un esquema de facultad no puede meterla dentro del documento', () => {
  assert.throws(
    () =>
      esquema.normalizar(
        { capitulos: [{ titulo: 'Capítulo I: Introducción', de: ['tsp-fase0-experiencia', 'tsp-fase1-introduccion'] }] },
        { catalogo: CATALOGO_TSP },
      ),
    /ficha de la experiencia/,
  );
});

test('los campos de cada fase del TSP se guardan, y lo inventado se descarta', () => {
  const limpio = etapas.limpiar('tsp-fase0-experiencia', {
    empresa: 'Distribuidora Norte SAC',
    cargo: 'Jefe de almacén',
    hipotesis: ['no debería guardarse'],
    evidencias: ['Kardex 2024', 'Actas de conformidad'],
  });
  assert.deepEqual(limpio, {
    empresa: 'Distribuidora Norte SAC',
    cargo: 'Jefe de almacén',
    evidencias: ['Kardex 2024', 'Actas de conformidad'],
  });
  assert.ok(etapas.definicionDe('tsp-fase4-resultados').campos.resultados, 'las cifras van en resultados');
});

test('el avance subido reparte los capítulos de un TSP por su nombre', () => {
  const contexto = { codigos: CODIGOS, esquema: null, tipo: 'tesis' };
  assert.equal(faseDelTitulo('CAPÍTULO III: DESCRIPCIÓN DE LA EXPERIENCIA', contexto), 'tsp-fase3-experiencia');
  assert.equal(faseDelTitulo('Metodología aplicada', contexto), 'tsp-fase3-experiencia');
  assert.equal(faseDelTitulo('Aspectos generales de la empresa', contexto), 'tsp-fase1-introduccion');
  assert.equal(faseDelTitulo('Introducción', contexto), 'tsp-fase1-introduccion');
  assert.equal(faseDelTitulo('Marco teórico', contexto), 'tsp-fase2-marco-teorico');
  assert.equal(faseDelTitulo('Resultados', contexto), 'tsp-fase4-resultados');
  assert.equal(faseDelTitulo('Conclusiones y recomendaciones', contexto), 'tsp-fase5-conclusiones');
  assert.equal(faseDelTitulo('Referencias', contexto), null);
});

test('y por su número cuando el capítulo no dice el nombre', () => {
  const contexto = { codigos: CODIGOS, esquema: null, tipo: 'tesis' };
  assert.equal(faseDelTitulo('CAPÍTULO III', contexto), 'tsp-fase3-experiencia');
  assert.equal(faseDelTitulo('Capítulo V', contexto), 'tsp-fase5-conclusiones');
});

test('en una tesis, «Metodología aplicada» sigue siendo la metodología', () => {
  const contexto = { codigos: ['problema-y-objetivos', 'metodologia'], esquema: null, tipo: 'tesis' };
  assert.equal(faseDelTitulo('Metodología aplicada', contexto), 'metodologia');
  assert.equal(faseDelTitulo('CAPÍTULO III', contexto), 'metodologia');
  assert.equal(faseDelTitulo('Descripción de la empresa', contexto), undefined);
});
