'use strict';

/**
 * Flujo de caja: cada día abre con el cierre del anterior, la caja empieza en
 * su saldo inicial (lo de antes no cuenta) y los días van en hora de Lima.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const datos = require('../src/modules/caja/caja.datos');

const INICIO = { id: 'i', dia: '2026-11-02', solesCents: 10000 };

function mov(dia, tipo, solesCents, extra = {}) {
  return { id: `${dia}-${tipo}-${solesCents}`, dia, tipo, solesCents, hora: null, ...extra };
}

test('el día de Lima: las 2 a. m. UTC del 4 aún son el día 3', () => {
  assert.equal(datos.diaDeLima('2026-11-04T02:00:00Z'), '2026-11-03');
  assert.equal(datos.diaDeLima('2026-11-04T05:00:00Z'), '2026-11-04');
  assert.equal(datos.inicioDelDia('2026-11-04').toISOString(), '2026-11-04T05:00:00.000Z');
  assert.equal(datos.diaSiguiente('2026-12-31'), '2027-01-01');
  assert.deepEqual(datos.diasDelMes(2028, 2), { primero: '2028-02-01', ultimo: '2028-02-29' });
});

test('sin saldo inicial la caja no ha empezado', () => {
  const caja = datos.armarCaja({ inicio: null, movimientos: [], anio: 2026, mes: 11, hoy: '2026-11-03' });
  assert.equal(caja.inicio, null);
  assert.deepEqual(caja.dias, []);
});

test('cada día abre con lo que cerró el anterior, hasta hoy, del más reciente al más antiguo', () => {
  const caja = datos.armarCaja({
    inicio: INICIO,
    movimientos: [
      mov('2026-11-02', 'ENTRADA', 5000),
      mov('2026-11-02', 'SALIDA', 2000),
      mov('2026-11-04', 'ENTRADA', 3000),
    ],
    anio: 2026,
    mes: 11,
    hoy: '2026-11-04',
  });

  assert.deepEqual(
    caja.dias.map((d) => [d.dia, d.aperturaCents, d.entradasCents, d.salidasCents, d.cierreCents]),
    [
      ['2026-11-04', 13000, 3000, 0, 16000],
      ['2026-11-03', 13000, 0, 0, 13000],
      ['2026-11-02', 10000, 5000, 2000, 13000],
    ],
  );
  assert.equal(caja.dias.at(-1).esInicio, true);
  assert.equal(caja.aperturaCents, 10000);
  assert.equal(caja.entradasCents, 8000);
  assert.equal(caja.salidasCents, 2000);
  assert.equal(caja.cierreCents, 16000);
});

test('un mes posterior abre con el cierre del anterior; lo de antes del inicio no cuenta', () => {
  const caja = datos.armarCaja({
    inicio: INICIO,
    movimientos: [
      mov('2026-10-30', 'ENTRADA', 99999), // antes del inicio: se ignora
      mov('2026-11-10', 'SALIDA', 4000),
      mov('2026-12-01', 'ENTRADA', 1000),
    ],
    anio: 2026,
    mes: 12,
    hoy: '2026-12-02',
  });
  assert.equal(caja.aperturaCents, 6000);
  assert.equal(caja.cierreCents, 7000);
  assert.equal(caja.dias.length, 2);
});

test('un mes anterior al inicio sale vacío y en cero', () => {
  const caja = datos.armarCaja({ inicio: INICIO, movimientos: [], anio: 2026, mes: 10, hoy: '2026-11-03' });
  assert.deepEqual(caja.dias, []);
  assert.equal(caja.cierreCents, 0);
});

test('una venta en dólares entra en soles y el día sale de la hora de Lima', () => {
  const entrada = datos.entradaDeVenta({
    fecha: '2026-11-04T03:00:00.000Z',
    origen: 'PAGO',
    origenId: 'p1',
    via: 'PayPal',
    producto: 'Método completo',
    cliente: 'Ana Ríos',
    correo: 'ana@x.com',
    moneda: 'USD',
    importeCents: 1000,
    solesCents: 3750,
  });
  assert.equal(entrada.dia, '2026-11-03');
  assert.equal(entrada.tipo, 'ENTRADA');
  assert.equal(entrada.solesCents, 3750);
  assert.equal(entrada.automatico, true);

  const servicio = datos.entradaDeServicio({
    id: 's1',
    concepto: 'Asesoría',
    importeCents: 2000,
    moneda: 'USD',
    pagadoEn: new Date('2026-11-03T15:00:00Z'),
    medio: 'Yape',
    clienteNombre: 'Luis',
  });
  assert.equal(servicio.solesCents, 7500);
  assert.equal(servicio.id, 'servicio:s1');
});
