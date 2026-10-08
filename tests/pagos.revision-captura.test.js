'use strict';

/**
 * Revisión automática de la captura de un pago manual (8-oct-2026).
 *
 * Se prueba el análisis del texto ya leído, no el OCR: tesseract es lento y
 * ya se ejercita con el reporte de Turnitin. Lo que se fija aquí es qué cuenta
 * como «parece un comprobante» y qué número de operación se saca de él.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analizarTexto } = require('../src/modules/payments/proof.revision');

// Lo que devuelve tesseract de una constancia de Yape, con sus tropiezos.
const CONSTANCIA_YAPE = `
¡Yapeaste!
S/ 59.90
Benicio A.
07 oct. 2026 - 08:05 pm
Nro. de operación
03 401 234
`;

test('una constancia de Yape con importe y operación es OK y da el número', () => {
  const r = analizarTexto(CONSTANCIA_YAPE, { amountCents: 5990, metodo: 'YAPE' });

  assert.equal(r.veredicto, 'OK');
  assert.equal(r.operacionLeida, '03401234');
  assert.equal(r.montoVisto, true);
});

test('el importe redondo se reconoce también sin céntimos, como lo enseña Yape', () => {
  const r = analizarTexto('Yapeaste S/ 69\nDestino: Benicio', { amountCents: 6900 });

  assert.equal(r.montoVisto, true);
  assert.equal(r.veredicto, 'OK');
  // Y no confunde 69 con 690 ni con 69.50.
  assert.equal(analizarTexto('Yape S/ 690', { amountCents: 6900 }).montoVisto, false);
  assert.equal(analizarTexto('Yape S/ 69.50', { amountCents: 6900 }).montoVisto, false);
});

test('la foto de otra cosa no parece un comprobante', () => {
  // Lo que saca el OCR de un tablero de auto de noche: casi nada.
  const r = analizarTexto('km/h 40 ~ 2 3 4 .\\ ,', { amountCents: 5990 });

  assert.equal(r.veredicto, 'NO_PARECE');
  assert.equal(r.operacionLeida, null);
  assert.equal(analizarTexto('', { amountCents: 5990 }).veredicto, 'NO_PARECE');
});

test('palabras de Yape sin importe ni operación quedan en duda', () => {
  const r = analizarTexto('Yape · Inicio · Movimientos', { amountCents: 5990 });

  assert.equal(r.veredicto, 'DUDOSO');
});

test('dice si el número declarado aparece en la imagen', () => {
  const opciones = { amountCents: 5990, metodo: 'YAPE' };

  assert.equal(analizarTexto(CONSTANCIA_YAPE, { ...opciones, operationCode: '03401234' }).operacionCoincide, true);
  assert.equal(analizarTexto(CONSTANCIA_YAPE, { ...opciones, operationCode: '99999999' }).operacionCoincide, false);
  assert.equal(analizarTexto(CONSTANCIA_YAPE, opciones).operacionCoincide, null);
});

test('en Western Union busca el MTCN de 10 dígitos', () => {
  const recibo = 'WESTERN UNION\nMoney Transfer Control Number (MTCN)\n123-456-7890\nUSD 45.00';
  const r = analizarTexto(recibo, { amountCents: 4500, metodo: 'WESTERN_UNION' });

  assert.equal(r.veredicto, 'OK');
  assert.equal(r.montoVisto, true);
  // El MTCN va separado de la palabra: lo encuentra por su lado.
  assert.equal(
    analizarTexto('Western Union MTCN: 1234567890', { metodo: 'WESTERN_UNION' }).operacionLeida,
    '1234567890',
  );
});
