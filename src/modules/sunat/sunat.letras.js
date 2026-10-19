'use strict';

/**
 * El monto en letras que SUNAT pide en la leyenda 1000 de la boleta:
 * «SON CIENTO CINCUENTA Y NUEVE CON 90/100 SOLES».
 */

const { MONEDA } = require('./sunat.catalogos');

const UNIDADES = [
  '', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE',
  'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS',
  'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE',
];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = [
  '', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
  'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS',
];

/** De 0 a 999. */
function hastaMil(n) {
  if (n === 100) return 'CIEN';
  const centena = CENTENAS[Math.floor(n / 100)];
  const resto = n % 100;
  let decena;
  if (resto < 30) decena = UNIDADES[resto];
  else {
    const unidad = resto % 10;
    decena = DECENAS[Math.floor(resto / 10)] + (unidad ? ` Y ${UNIDADES[unidad]}` : '');
  }
  return [centena, decena].filter(Boolean).join(' ');
}

/** Entero en letras, de 0 a 999 999 999. «UNO» se apocopa ante MIL y MILLONES. */
function enteroEnLetras(n) {
  if (n === 0) return 'CERO';
  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];
  if (millones === 1) partes.push('UN MILLÓN');
  else if (millones) partes.push(`${hastaMil(millones).replace(/UNO$/, 'UN')} MILLONES`);
  if (miles === 1) partes.push('MIL');
  else if (miles) partes.push(`${hastaMil(miles).replace(/UNO$/, 'UN')} MIL`);
  if (resto) partes.push(hastaMil(resto));
  return partes.join(' ');
}

/** `15990` céntimos en PEN → «SON CIENTO CINCUENTA Y NUEVE CON 90/100 SOLES». */
function montoEnLetras(centimos, moneda) {
  const nombre = MONEDA[moneda];
  if (!nombre) throw new Error(`Moneda no admitida: ${moneda}`);
  if (!Number.isInteger(centimos) || centimos < 0 || centimos >= 1e11) {
    throw new Error(`Importe fuera de rango: ${centimos}`);
  }
  const enteros = Math.floor(centimos / 100);
  const decimales = String(centimos % 100).padStart(2, '0');
  return `SON ${enteroEnLetras(enteros)} CON ${decimales}/100 ${nombre}`;
}

module.exports = { montoEnLetras, enteroEnLetras };
