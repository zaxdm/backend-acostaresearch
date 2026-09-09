'use strict';

/**
 * El repaso antes de entregar.
 *
 * No lee la tesis: la compara con lo que ella misma dice que iba a hacer. Estas
 * pruebas fijan los cotejos que sí valen —un objetivo sin conclusión, una
 * variable que no aparece en ningún objetivo, un capítulo cerrado y vacío— y
 * comprueban que no invente hallazgos donde no los hay.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const auditoria = require('../src/modules/projects/project.auditoria');

const CATALOGO = [
  { code: 'tema-y-delimitacion', displayName: '1 · Tema y delimitación' },
  { code: 'problema-y-objetivos', displayName: '2 · Problema y objetivos' },
  { code: 'marco-teorico', displayName: '3 · Marco teórico' },
  { code: 'conclusiones-abstract', displayName: '9 · Conclusiones' },
];

const VACIO = { capitulos: [], total: { sinRespaldo: 0, citasAMano: 0 } };

function auditar(parcial) {
  return auditoria.auditar({
    proyecto: { tema: 'Deserción universitaria' },
    catalogo: CATALOGO,
    etapas: [],
    capitulos: [],
    evidencia: VACIO,
    citasRotas: [],
    ...parcial,
  });
}

const mensajes = (informe) => informe.hallazgos.map((h) => h.mensaje).join(' | ');

test('un capítulo dado por bueno y sin texto es grave', () => {
  const r = auditar({
    etapas: [{ skillCode: 'marco-teorico', estado: 'LISTO', palabras: 0, datos: {} }],
  });

  assert.equal(r.graves, 1);
  assert.match(mensajes(r), /Marco teórico.*no tiene texto/);
});

test('un capítulo cerrado y escrito no dice nada', () => {
  const r = auditar({
    etapas: [{ skillCode: 'marco-teorico', estado: 'LISTO', palabras: 3200, datos: {} }],
    capitulos: [{ code: 'marco-teorico', titulo: '3 · Marco teórico', texto: 'Con fuentes [AR11112222].' }],
    evidencia: {
      capitulos: [{ titulo: '3 · Marco teórico', conRespaldo: [{}], sinRespaldo: [], citasAMano: [] }],
      total: { sinRespaldo: 0, citasAMano: 0 },
    },
  });

  assert.equal(r.hallazgos.length, 0);
});

test('una variable que no aparece en ningún objetivo se señala', () => {
  const r = auditar({
    etapas: [
      {
        skillCode: 'problema-y-objetivos',
        estado: 'LISTO',
        palabras: 100,
        datos: {
          objetivoGeneral: 'Determinar los factores económicos asociados al abandono',
          objetivosEspecificos: ['Identificar los factores económicos de las familias'],
          variables: ['factores económicos', 'clima institucional'],
        },
      },
    ],
  });

  assert.match(mensajes(r), /clima institucional.*no aparece en ningún objetivo/);
  assert.ok(!mensajes(r).includes('«factores económicos» no aparece'), 'esa sí aparece');
});

test('un objetivo específico sin conclusión se señala como duda, no como sentencia', () => {
  const r = auditar({
    etapas: [
      {
        skillCode: 'problema-y-objetivos',
        estado: 'LISTO',
        palabras: 100,
        datos: {
          objetivosEspecificos: [
            'Identificar los factores económicos del abandono estudiantil',
            'Medir la incidencia del acompañamiento tutorial docente',
          ],
        },
      },
    ],
    capitulos: [
      {
        code: 'conclusiones-abstract',
        titulo: '9 · Conclusiones',
        texto:
          'Se concluye que los factores económicos explican buena parte del abandono ' +
          'estudiantil observado en la muestra.',
      },
    ],
  });

  const texto = mensajes(r);
  assert.match(texto, /acompañamiento tutorial/);
  assert.match(texto, /puede que no esté respondido/);
  assert.ok(!texto.includes('factores económicos del abandono'), 'el primero sí está respondido');
});

test('sin conclusiones escritas no se inventa que falten', () => {
  // Que no estén escritas todavía no es un hallazgo: es que va por el capítulo
  // tres.
  const r = auditar({
    etapas: [
      {
        skillCode: 'problema-y-objetivos',
        estado: 'LISTO',
        palabras: 100,
        datos: { objetivosEspecificos: ['Identificar los factores económicos del abandono'] },
      },
    ],
  });

  assert.equal(r.hallazgos.length, 0);
});

test('un marco teórico sin una sola cita es grave', () => {
  const r = auditar({
    capitulos: [{ code: 'marco-teorico', titulo: '3 · Marco teórico', texto: 'Sin citas.' }],
    evidencia: {
      capitulos: [{ titulo: '3 · Marco teórico', conRespaldo: [], sinRespaldo: [], citasAMano: [] }],
      total: { sinRespaldo: 0, citasAMano: 0 },
    },
  });

  assert.equal(r.graves, 1);
  assert.match(mensajes(r), /no cita ni una sola fuente/);
});

test('una cita rota se señala con su clave', () => {
  const r = auditar({ citasRotas: ['ARDEADBEEF'] });

  assert.equal(r.graves, 1);
  assert.match(mensajes(r), /ARDEADBEEF/);
});

test('las citas escritas a mano suben a grave', () => {
  const r = auditar({ evidencia: { capitulos: [], total: { sinRespaldo: 2, citasAMano: 3 } } });

  assert.equal(r.graves, 1, 'las citas a mano');
  assert.equal(r.avisos, 1, 'las afirmaciones sin fuente');
  assert.match(mensajes(r), /3 citas escritas a mano/);
});

test('un requisito sin cubrir se arrastra al repaso', () => {
  const r = auditar({
    etapas: [
      { skillCode: 'problema-y-objetivos', estado: 'EN_CURSO', palabras: 0, datos: {}, faltan: ['Población'] },
    ],
  });

  assert.match(mensajes(r), /se apoya en Población/);
});

test('un capítulo sin empezar no arrastra sus requisitos', () => {
  // Avisar de lo que le falta a un capítulo que nadie ha tocado es ruido: le
  // falta todo, y por eso está sin empezar.
  const r = auditar({
    etapas: [
      { skillCode: 'problema-y-objetivos', estado: 'PENDIENTE', palabras: 0, datos: {}, faltan: ['Población'] },
    ],
  });

  assert.equal(r.hallazgos.length, 0);
});

test('se dice qué queda por escribir', () => {
  const r = auditar({
    capitulos: [{ code: 'marco-teorico', titulo: '3 · Marco teórico', texto: 'Algo.' }],
    evidencia: {
      capitulos: [{ titulo: '3 · Marco teórico', conRespaldo: [{}], sinRespaldo: [], citasAMano: [] }],
      total: { sinRespaldo: 0, citasAMano: 0 },
    },
  });

  assert.equal(r.escritos, 1);
  assert.equal(r.sinEscribir.length, 3);
});

test('el cotejo aguanta tildes y mayúsculas', () => {
  assert.equal(auditoria.apareceEn('Deserción Universitaria', 'la desercion universitaria crece'), true);
  assert.equal(auditoria.apareceEn('clima institucional', 'los factores economicos'), false);
});

test('un objetivo hecho solo de palabras vacías no se marca', () => {
  // «Determinar el objetivo general del estudio» no tiene contenido con el que
  // cotejar. Marcarlo sería inventarse un hallazgo.
  assert.equal(auditoria.apareceEn('Determinar', 'cualquier texto'), true);
});

// ── La cadena metodología → instrumento → análisis ──────────────────────────
//
// Es la que un jurado recorre entera, y la que más se rompe por el medio:
// cada capítulo se escribe semanas después del anterior.

function conDatos(porEtapa) {
  return auditar({
    etapas: Object.entries(porEtapa).map(([skillCode, datos]) => ({
      skillCode,
      estado: 'LISTO',
      palabras: 500,
      datos,
    })),
    capitulos: Object.keys(porEtapa).map((code) => ({ code, titulo: code, texto: 'Texto.' })),
  });
}

test('una variable que el instrumento no mide se señala', () => {
  const r = conDatos({
    'problema-y-objetivos': {
      objetivoGeneral: 'Determinar los factores económicos y el clima institucional',
      variables: ['factores económicos', 'clima institucional'],
    },
    'instrumento-investigacion': {
      nombre: 'Cuestionario de deserción',
      dimensiones: ['factores económicos familiares'],
    },
  });

  assert.match(mensajes(r), /clima institucional.*no aparece entre las dimensiones/);
  assert.ok(!/«factores económicos» no aparece entre las dimensiones/.test(mensajes(r)));
});

test('un enfoque cualitativo con pruebas estadísticas es grave', () => {
  const r = conDatos({
    metodologia: { enfoque: 'Cualitativo', analisis: [] },
    'analisis-datos-rstudio': { pruebas: ['Alfa de Cronbach', 'Regresión lineal'] },
  });

  assert.equal(r.graves, 1);
  assert.match(mensajes(r), /Una de las dos cosas no es la que se hizo/);
});

test('un enfoque cuantitativo con pruebas estadísticas no dice nada', () => {
  const r = conDatos({
    metodologia: { enfoque: 'Cuantitativo', analisis: ['Regresión lineal'] },
    'analisis-datos-rstudio': { pruebas: ['Regresión lineal múltiple'] },
  });

  assert.equal(r.graves, 0);
});

test('una prueba prometida y no realizada se señala', () => {
  const r = conDatos({
    metodologia: { enfoque: 'Cuantitativo', analisis: ['Regresión logística', 'Alfa de Cronbach'] },
    'analisis-datos-rstudio': { pruebas: ['Alfa de Cronbach'] },
  });

  assert.match(mensajes(r), /Regresión logística.*no aparece entre las pruebas/);
});

test('el instrumento llamado de dos maneras distintas se señala', () => {
  const r = conDatos({
    metodologia: { enfoque: 'Cuantitativo', instrumento: 'Cuestionario de deserción académica' },
    'instrumento-investigacion': { nombre: 'Escala de clima institucional' },
  });

  assert.match(mensajes(r), /llámalo igual en los dos sitios/);
});

test('el mismo instrumento nombrado igual no dice nada', () => {
  const r = conDatos({
    metodologia: { enfoque: 'Cuantitativo', instrumento: 'Cuestionario de deserción académica' },
    'instrumento-investigacion': { nombre: 'Cuestionario de deserción académica (versión final)' },
  });

  assert.equal(r.hallazgos.length, 0);
});
