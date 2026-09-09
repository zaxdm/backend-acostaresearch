'use strict';

/**
 * El detector se calibró contra las doce primeras alertas reales del sistema.
 * Diez eran falsas, y la mayoría por la misma razón: comparar a un comprador
 * contra un histórico que todavía no existía. Estas pruebas fijan ese caso para
 * que no vuelva, sin apagar las señales que sí distinguen a dos personas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analizar, NIVELES } = require('../src/modules/licensing/license.detector');

const AHORA = new Date('2026-09-09T20:00:00.000Z');
const DIA_MS = 24 * 60 * 60 * 1000;

/** Llamadas repartidas por el día, a la hora que se pida. */
function llamadas(cuantas, { diasAtras = 0, sesion = 's1', tema = 'h1', cadaSegundos = 900 } = {}) {
  const base = AHORA.getTime() - diasAtras * DIA_MS - cuantas * cadaSegundos * 1000;
  return Array.from({ length: cuantas }, (_, i) => ({
    createdAt: new Date(base + i * cadaSegundos * 1000),
    sessionId: sesion,
    promptHash: tema,
  }));
}

/** Un comprador con semanas de uso tranquilo detrás. */
function historicoTranquilo(dias, porDia) {
  const usos = [];
  for (let d = 1; d <= dias; d += 1) usos.push(...llamadas(porDia, { diasAtras: d }));
  return usos;
}

function codigos(diagnostico) {
  return diagnostico.senales.map((s) => s.codigo);
}

test('un comprador que estrena su licencia no es sospechoso por usarla', () => {
  // El caso exacto de producción: 21 llamadas el primer día, mediana cero.
  const d = analizar(llamadas(21), { ahora: AHORA });

  assert.equal(d.nivel, NIVELES.NORMAL);
  assert.deepEqual(codigos(d), []);
  assert.equal(d.metricas.hayConQueComparar, false);
});

test('tampoco con dos días de vida, que es cuando saltaban las alertas falsas', () => {
  const usos = [...llamadas(4, { diasAtras: 2 }), ...llamadas(4, { diasAtras: 1 }), ...llamadas(17)];
  const d = analizar(usos, { ahora: AHORA });

  assert.equal(d.nivel, NIVELES.NORMAL);
  assert.equal(d.metricas.diasConHistorico, 2);
});

test('con historial de sobra, un salto de volumen sí se señala', () => {
  const usos = [...historicoTranquilo(10, 4), ...llamadas(40)];
  const d = analizar(usos, { ahora: AHORA });

  assert.ok(codigos(d).includes('VOLUMEN_DISPARADO'));
  assert.equal(d.metricas.hayConQueComparar, true);
});

test('con historial, un día algo movido se queda en aviso y no en sospecha', () => {
  const usos = [...historicoTranquilo(10, 4), ...llamadas(14)];
  const d = analizar(usos, { ahora: AHORA });

  assert.deepEqual(codigos(d), ['VOLUMEN_ALTO']);
  assert.equal(d.nivel, NIVELES.ALERTA);
});

test('un solo par de consultas seguidas sobre temas distintos no es nada', () => {
  // Preguntar por el capítulo II y acto seguido por el IV produce justo esto.
  const usos = [
    { createdAt: new Date(AHORA.getTime() - 60_000), sessionId: 'a', promptHash: 'marco' },
    { createdAt: new Date(AHORA.getTime() - 30_000), sessionId: 'b', promptHash: 'resultados' },
  ];
  const d = analizar(usos, { ahora: AHORA });

  assert.ok(!codigos(d).includes('CONSULTAS_INCOHERENTES'));
});

test('tres pares incoherentes ya cuesta explicarlos con una sola persona', () => {
  const usos = [];
  for (let i = 0; i < 3; i += 1) {
    const t = AHORA.getTime() - (i + 1) * 3600_000;
    usos.push({ createdAt: new Date(t), sessionId: 'a' + i, promptHash: 'tema' + i });
    usos.push({ createdAt: new Date(t + 20_000), sessionId: 'b' + i, promptHash: 'otro' + i });
  }
  const d = analizar(usos, { ahora: AHORA });

  assert.ok(codigos(d).includes('CONSULTAS_INCOHERENTES'));
});

test('las sesiones solapadas siguen delatando desde el primer día', () => {
  // Sin histórico ninguno: es la señal que tiene que funcionar el día uno,
  // porque dos personas a la vez no dependen de cuánto lleve la licencia.
  const usos = [];
  for (let i = 0; i < 6; i += 1) {
    const t = AHORA.getTime() - i * 300_000;
    usos.push({ createdAt: new Date(t), sessionId: 'sesion-' + i, promptHash: 'x' });
    usos.push({ createdAt: new Date(t + 30_000), sessionId: 'sesion-' + (i + 10), promptHash: 'x' });
  }
  const d = analizar(usos, { ahora: AHORA });

  assert.equal(d.metricas.hayConQueComparar, false, 'no tiene histórico');
  assert.equal(d.nivel, NIVELES.SOSPECHA_ALTA);
  assert.ok(codigos(d).includes('MUCHAS_SESIONES'));
  assert.ok(codigos(d).includes('SESIONES_SOLAPADAS'));
});

test('un comprador con historial y un día de calma no genera ruido', () => {
  const usos = [...historicoTranquilo(10, 4), ...llamadas(3)];
  const d = analizar(usos, { ahora: AHORA });

  assert.equal(d.nivel, NIVELES.NORMAL);
  assert.deepEqual(codigos(d), []);
});

test('la fiabilidad avisa de que falta la mitad de la información', () => {
  const sinHistorico = analizar(llamadas(21), { ahora: AHORA });
  assert.equal(sinHistorico.fiabilidad, 'limitada');

  const completo = analizar([...historicoTranquilo(10, 4), ...llamadas(6)], { ahora: AHORA });
  assert.equal(completo.fiabilidad, 'normal');
});
