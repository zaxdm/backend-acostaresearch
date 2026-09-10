'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { precioAnterior } = require('../src/modules/billing/product.service');

/**
 * Lo que se prueba aquí es lo que el comprador lee antes de pagar.
 *
 * Una oferta son dos cifras: la que se cobra —`priceCents`, la única que llega
 * a PayPal o al comprobante de Yape— y la que se tacha. Esta función decide la
 * segunda, y solo puede equivocarse en una dirección peligrosa: dejar guardado
 * un «antes» que no sea mayor que el precio vigente. Eso pinta un tachado por
 * debajo de lo que se cobra, que es anunciar una rebaja que no existe.
 */

test('un precio mayor que el vigente sí es una oferta y se guarda', () => {
  assert.equal(precioAnterior(19900, 15900), 19900);
});

test('un «antes» igual al vigente no tacha nada: se guarda nulo', () => {
  assert.equal(precioAnterior(15900, 15900), null);
});

test('un «antes» por debajo del vigente sería una rebaja al revés: se descarta', () => {
  assert.equal(precioAnterior(9900, 15900), null);
});

test('nulo explícito quita la oferta', () => {
  assert.equal(precioAnterior(null, 15900), null);
});

test('sin valor no se toca la oferta que hubiera', () => {
  assert.equal(precioAnterior(undefined, 15900), undefined);
});

test('un plan gratuito no puede estar de oferta contra cero', () => {
  assert.equal(precioAnterior(0, 0), null);
});
