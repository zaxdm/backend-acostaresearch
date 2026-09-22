'use strict';

/**
 * El cupo de la membresía de «Preparar documento».
 *
 * Es la regla que decide si alguien trabaja o no, y la única que el cliente no
 * puede comprobar mirando el resultado: si la cuenta está mal, no ve un error,
 * ve que «se le acabaron» diez documentos llevando tres. Por eso se prueba
 * entera, con el reloj entrando por parámetro.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const membresia = require('../src/modules/preparar/preparar.membresia');

const DIA = 24 * 60 * 60 * 1000;
const dias = (n) => n * DIA;

const ACTIVADA = new Date('2026-09-22T10:00:00Z');

/** Una membresía trimestral: noventa días, diez documentos al mes. */
const trimestral = (extra = {}) => ({
  docsPorMes: 10,
  status: 'ACTIVE',
  activatedAt: ACTIVADA,
  expiresAt: new Date(ACTIVADA.getTime() + dias(90)),
  ...extra,
});

const mensual = (extra = {}) => ({
  docsPorMes: 10,
  status: 'ACTIVE',
  activatedAt: ACTIVADA,
  expiresAt: new Date(ACTIVADA.getTime() + dias(30)),
  ...extra,
});

const enElDia = (n, horas = 0) => new Date(ACTIVADA.getTime() + dias(n) + horas * 60 * 60 * 1000);

test('la ventana son treinta días desde la activación, no el mes del calendario', () => {
  const pack = trimestral();

  assert.equal(membresia.ventanaDe(pack, ACTIVADA).numero, 1);
  assert.equal(membresia.ventanaDe(pack, enElDia(29, 23)).numero, 1);
  // El día 30 empieza la segunda, no el 1 del mes siguiente.
  assert.equal(membresia.ventanaDe(pack, enElDia(30)).numero, 2);
  assert.equal(membresia.ventanaDe(pack, enElDia(89)).numero, 3);
});

test('la ventana dice desde y hasta cuándo va, para poder anunciar la renovación', () => {
  const ventana = membresia.ventanaDe(trimestral(), enElDia(35));

  assert.deepEqual(ventana.desde, enElDia(30));
  assert.deepEqual(ventana.hasta, enElDia(60));
});

test('una fecha anterior a la activación cae en la primera ventana, nunca en la cero', () => {
  const ventana = membresia.ventanaDe(trimestral(), new Date(ACTIVADA.getTime() - dias(5)));

  assert.equal(ventana.numero, 1);
  assert.deepEqual(ventana.desde, ACTIVADA);
});

test('la mensual cubre una ventana y la trimestral, tres', () => {
  assert.equal(membresia.ventanasDe(mensual()), 1);
  assert.equal(membresia.ventanasDe(trimestral()), 3);
});

test('el cupo se cuenta por ventana: lo gastado el mes pasado no resta este mes', () => {
  const pack = trimestral();

  // Diez gastados en la primera ventana: agotada.
  assert.equal(membresia.cupoDe(pack, 10, enElDia(20)).restantes, 0);
  // En la segunda, la cuenta que llega es la de SU ventana. Aquí, ninguna.
  const segunda = membresia.cupoDe(pack, 0, enElDia(35));
  assert.equal(segunda.restantes, 10);
  assert.equal(segunda.ventana, 2);
  assert.equal(segunda.ventanas, 3);
});

test('el cupo nunca sale en negativo, aunque se haya bajado el tope a mitad de mes', () => {
  const cupo = membresia.cupoDe(trimestral({ docsPorMes: 5 }), 8, enElDia(3));

  assert.equal(cupo.total, 5);
  assert.equal(cupo.usados, 8);
  assert.equal(cupo.restantes, 0);
});

test('sin membresía, el motivo invita a comprarla', () => {
  assert.match(membresia.porQueNo(null, 0), /Necesitas una membresía/);
});

test('caducada y revocada se dicen distinto: una se renueva y la otra se consulta', () => {
  const caducada = trimestral({ expiresAt: new Date(ACTIVADA.getTime() - dias(1)) });
  assert.match(membresia.porQueNo(caducada, 0, ACTIVADA), /caducó/);

  const revocada = trimestral({ status: 'REVOKED' });
  assert.match(membresia.porQueNo(revocada, 0, ACTIVADA), /anulada/);
});

test('agotado el mes se dice cuántos días faltan para volver a tener cupo', () => {
  const motivo = membresia.porQueNo(trimestral(), 10, enElDia(25));

  assert.match(motivo, /Ya usaste los 10 documentos de este mes/);
  assert.match(motivo, /en 5 días/);
});

test('con cupo y vigente no hay motivo: puede trabajar', () => {
  assert.equal(membresia.porQueNo(trimestral(), 3, enElDia(10)), null);
});

test('una membresía vale hasta el último instante y ni uno más', () => {
  const pack = mensual();

  assert.equal(membresia.vigente(pack, enElDia(29, 23)), true);
  assert.equal(membresia.vigente(pack, enElDia(30)), false);
  assert.equal(membresia.vigente(null, ACTIVADA), false);
});
