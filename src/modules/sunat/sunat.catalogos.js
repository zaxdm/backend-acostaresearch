'use strict';

/**
 * Catálogos de SUNAT que usa la boleta electrónica (anexo 8 de la R.S.
 * 097-2012/SUNAT y sus modificatorias). Solo están los códigos que emite
 * Acosta; un código que no está aquí se rechaza antes de enviar nada.
 */

/** Catálogo 01: tipo de comprobante. */
const TIPO_COMPROBANTE = {
  BOLETA: '03',
  NOTA_CREDITO: '07',
};

/** Catálogo 09: motivo de la nota de crédito. Solo la anulación, que es lo que se usa. */
const MOTIVO_NOTA_CREDITO = {
  ANULACION: '01', // anulación de la operación
};

/**
 * Catálogo 07 (afectación del IGV) con el tributo que le corresponde
 * (catálogo 05). `porcentaje` es el IGV que se cobra dentro del precio.
 *
 * La afectación viene en cada ítem. Hoy todas las ventas van con 10
 * (gravado, RER con IGV; confirmado por el contador el 19-oct-2026): la
 * fija `sunat.ventas.js`.
 */
const AFECTACION = {
  10: { tributo: '1000', nombre: 'IGV', tipo: 'VAT', porcentaje: 18 }, // gravado
  20: { tributo: '9997', nombre: 'EXO', tipo: 'VAT', porcentaje: 0 }, // exonerado
  30: { tributo: '9998', nombre: 'INA', tipo: 'FRE', porcentaje: 0 }, // inafecto
  40: { tributo: '9995', nombre: 'EXP', tipo: 'FRE', porcentaje: 0 }, // exportación
};

/**
 * Catálogo 51: tipo de operación. 0113 es la venta interna de un contribuyente
 * del Nuevo RUS, que solo puede ir en boleta.
 */
const TIPO_OPERACION = {
  VENTA_INTERNA: '0101',
  VENTA_NRUS: '0113',
};

/** Catálogo 06: documento de identidad del cliente. */
const TIPO_DOCUMENTO = {
  NO_DOMICILIADO: '0', // extranjero sin documento peruano
  DNI: '1',
  CARNE_EXTRANJERIA: '4',
  RUC: '6',
  PASAPORTE: '7',
  VARIOS: '-', // venta menor a S/700 sin identificar al cliente
};

/** Monedas que se cobran, con el nombre que va en el monto en letras. */
const MONEDA = {
  PEN: 'SOLES',
  USD: 'DÓLARES AMERICANOS',
};

/** Direcciones del servicio de envío (SEE – Del Contribuyente). */
const SERVICIO = {
  beta: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
  produccion: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
};

module.exports = { TIPO_COMPROBANTE, MOTIVO_NOTA_CREDITO, AFECTACION, TIPO_OPERACION, TIPO_DOCUMENTO, MONEDA, SERVICIO };
