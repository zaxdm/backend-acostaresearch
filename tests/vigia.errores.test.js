'use strict';

/**
 * Los errores del backend al móvil: el primero al momento, los demás juntos
 * cada 15 minutos, y un resumen diario a las 8 de Lima aunque no haya nada.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearVigiaDeErrores, mensajeDeLlamada } = require('../src/lib/vigiaErrores');

/** 30-sep-2026 a las 10:00 de Lima (15:00 UTC). */
const DIEZ_EN_LIMA = Date.UTC(2026, 8, 30, 15, 0);
const MIN = 60 * 1000;

function preparar(inicio = DIEZ_EN_LIMA) {
  let reloj = inicio;
  const avisos = [];
  const vigia = crearVigiaDeErrores({ avisar: (a) => avisos.push(a), ahora: () => reloj });
  return { vigia, avisos, pasar: (ms) => (reloj += ms) };
}

test('el primer error avisa al momento y los siguientes esperan a la ventana', () => {
  const { vigia, avisos, pasar } = preparar();
  vigia.registrar('La pasarela rechazó el cobro');
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].titulo, 'Error en el backend');
  assert.match(avisos[0].mensaje, /1× La pasarela rechazó el cobro/);

  pasar(MIN);
  vigia.registrar('La base no responde');
  vigia.registrar('La base no responde');
  vigia.registrar('Otro fallo');
  assert.equal(avisos.length, 1, 'dentro de la ventana no se manda nada');

  vigia.vaciar();
  assert.equal(avisos.length, 2);
  assert.equal(avisos[1].titulo, '3 errores en el backend');
  assert.match(avisos[1].mensaje, /^2× La base no responde\n1× Otro fallo/);

  vigia.vaciar();
  assert.equal(avisos.length, 2, 'sin pendientes no se avisa');
});

test('pasada la ventana, el siguiente error vuelve a avisar al momento', () => {
  const { vigia, avisos, pasar } = preparar();
  vigia.registrar('uno');
  pasar(16 * MIN);
  vigia.registrar('dos');
  assert.equal(avisos.length, 2);
});

test('los errores del propio aviso no se cuentan, para no hacer un bucle', () => {
  const { vigia, avisos } = preparar();
  vigia.registrar('El servidor de avisos rechazó la notificación');
  assert.equal(avisos.length, 0);
});

test('el resumen sale una vez al día desde las 8 de Lima, también sin errores', () => {
  // Arranca a las 10: hoy ya no toca resumen.
  const { vigia, avisos, pasar } = preparar();
  assert.equal(vigia.quizaResumen(), false);

  vigia.registrar('uno');
  avisos.length = 0;
  pasar(21 * 60 * MIN); // 07:00 del día siguiente
  assert.equal(vigia.quizaResumen(), false);

  pasar(60 * MIN); // 08:00
  assert.equal(vigia.quizaResumen(), true);
  assert.equal(avisos[0].titulo, 'Backend: 1 errores');
  assert.match(avisos[0].mensaje, /arranque del servicio/);
  assert.equal(vigia.quizaResumen(), false, 'no se repite el mismo día');

  pasar(24 * 60 * MIN);
  assert.equal(vigia.quizaResumen(), true);
  assert.equal(avisos[1].titulo, 'Backend: sin errores');
  assert.equal(avisos[1].prioridad, 2);
});

test('el mensaje sale del texto de la llamada, nunca del objeto con datos', () => {
  assert.equal(mensajeDeLlamada([{ userId: 'u1', correo: 'x@y.pe' }, 'Falló el cobro']), 'Falló el cobro');
  assert.equal(mensajeDeLlamada(['Solo texto']), 'Solo texto');
  assert.equal(mensajeDeLlamada([{ err: new Error('ECONNREFUSED') }]), 'ECONNREFUSED');
});
