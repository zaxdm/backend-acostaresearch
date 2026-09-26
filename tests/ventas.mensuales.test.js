'use strict';

/**
 * Ventas mensuales: qué cuenta como venta de un mes, los meses que faltan por
 * cerrar y que el PDF se genera con y sin ventas. La regla de qué es una venta
 * es la misma que la de los gráficos de ingresos del panel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const datos = require('../src/modules/ventas/ventas.datos');
const { generarReporte, nombreDeArchivo } = require('../src/modules/ventas/ventas.pdf');

test('los meses van en hora de Lima: el 1 de octubre a las 3 a. m. UTC aún es septiembre', () => {
  assert.deepEqual(datos.mesDeLima(new Date('2026-10-01T03:00:00Z')), { anio: 2026, mes: 9 });
  assert.deepEqual(datos.mesDeLima(new Date('2026-10-01T05:00:00Z')), { anio: 2026, mes: 10 });
  assert.equal(datos.inicioDelMes(2026, 10).toISOString(), '2026-10-01T05:00:00.000Z');
});

test('meses terminados: desde la primera venta hasta el mes anterior, cruzando el año', () => {
  const meses = datos.mesesTerminados({ anio: 2026, mes: 11 }, new Date('2027-02-10T12:00:00Z'));
  assert.deepEqual(meses, [
    { anio: 2026, mes: 11 },
    { anio: 2026, mes: 12 },
    { anio: 2027, mes: 1 },
  ]);
  assert.deepEqual(datos.mesesTerminados({ anio: 2026, mes: 9 }, new Date('2026-09-20T12:00:00Z')), []);
});

const PAGO_PAYPAL = {
  id: 'p1',
  provider: 'PAYPAL',
  providerOrderId: 'ORDEN-1',
  providerCaptureId: 'CAP-1',
  amountCents: 2000,
  currency: 'USD',
  paidAt: new Date('2026-09-10T15:00:00Z'),
  plan: { name: 'Método completo' },
  user: { firstName: 'Ana', lastName: 'Ríos', email: 'ana@x.com' },
};
const PAGO_DE_CANJE = {
  id: 'p2',
  provider: 'YAPE',
  providerOrderId: 'codigo-1',
  amountCents: 15000,
  currency: 'PEN',
  paidAt: new Date('2026-09-12T15:00:00Z'),
  plan: { name: 'Método completo' },
  user: { email: 'luis@x.com' },
};
const CODIGO = {
  id: 'codigo-1',
  hint: 'AB12',
  productCode: 'METODO_9_SKILLS',
  buyerEmail: 'luis@x.com',
  paymentMethod: 'YAPE',
  paymentRef: '123456',
  amountCents: 15000,
  createdAt: new Date('2026-09-05T15:00:00Z'),
};

test('el pago del canje no se cuenta dos veces: la venta es la del código', () => {
  const ventas = datos.ventasDelMes({
    pagos: [PAGO_PAYPAL, PAGO_DE_CANJE],
    codigos: [CODIGO],
    idsDeCodigos: new Set(['codigo-1']),
    nombresDeProducto: { METODO_9_SKILLS: 'Método completo' },
  });

  assert.equal(ventas.length, 2);
  // Ordenadas por fecha: el código (día 5) antes que PayPal (día 10).
  assert.equal(ventas[0].origen, 'CODIGO');
  assert.equal(ventas[0].producto, 'Método completo');
  assert.equal(ventas[0].referencia, '123456');
  assert.equal(ventas[1].via, 'PayPal');
  assert.equal(ventas[1].cliente, 'Ana Ríos');
});

test('el resumen separa monedas y pasa los dólares a soles al tipo de referencia', () => {
  const ventas = datos.ventasDelMes({
    pagos: [PAGO_PAYPAL],
    codigos: [CODIGO],
    idsDeCodigos: new Set(),
  });
  const resumen = datos.resumir(ventas);

  assert.equal(resumen.ventas, 2);
  assert.deepEqual(resumen.totalesPorMoneda, { PEN: 15000, USD: 2000 });
  assert.equal(resumen.totalSolesCents, 15000 + Math.round(2000 * datos.SOLES_POR_DOLAR));
  assert.equal(resumen.porVia.PayPal, 7500);
});

test('el PDF sale con ventas, sin ventas y con muchas (varias páginas)', async () => {
  const periodo = { anio: 2026, mes: 9 };
  const ventas = datos.ventasDelMes({ pagos: [PAGO_PAYPAL], codigos: [CODIGO] });

  const conVentas = await generarReporte({
    periodo,
    ventas,
    resumen: datos.resumir(ventas),
    solesPorDolar: datos.SOLES_POR_DOLAR,
    generado: new Date('2026-10-01T06:00:00Z'),
    borrador: false,
  });
  assert.equal(conVentas.subarray(0, 5).toString(), '%PDF-');

  const vacio = await generarReporte({
    periodo,
    ventas: [],
    resumen: datos.resumir([]),
    solesPorDolar: datos.SOLES_POR_DOLAR,
    generado: new Date(),
    borrador: true,
  });
  assert.equal(vacio.subarray(0, 5).toString(), '%PDF-');

  const muchas = Array.from({ length: 80 }, () => ventas).flat();
  const largo = await generarReporte({
    periodo,
    ventas: muchas,
    resumen: datos.resumir(muchas),
    solesPorDolar: datos.SOLES_POR_DOLAR,
    generado: new Date(),
    borrador: false,
  });
  const paginas = largo.toString('latin1').match(/\/Type \/Page\b/g) ?? [];
  assert.ok(paginas.length > 1, `esperaba varias páginas y salieron ${paginas.length}`);

  assert.equal(nombreDeArchivo(periodo), 'ventas-2026-09.pdf');
  assert.equal(nombreDeArchivo(periodo, true), 'ventas-2026-09-borrador.pdf');
});
