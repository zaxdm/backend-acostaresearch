'use strict';

/**
 * Nota de crédito electrónica (UBL 2.1, tipo 07) que anula una boleta.
 *
 * Una boleta aceptada por SUNAT no se borra: se anula con una nota de crédito
 * que la cita y devuelve el mismo importe, con el mismo cliente y las mismas
 * líneas. Solo se usa el motivo 01, «anulación de la operación». La serie
 * empieza por B porque anula una boleta.
 *
 * Igual que `construirBoleta`: recibe todo por parámetro, no toca la base y
 * devuelve el XML sin firmar.
 */

const { TIPO_COMPROBANTE, MOTIVO_NOTA_CREDITO, TIPO_DOCUMENTO, MONEDA } = require('./sunat.catalogos');
const { montoEnLetras } = require('./sunat.letras');
const {
  nombreDelArchivo,
  ID_FIRMA,
  decimal,
  fechaLima,
  escapar,
  partirLinea,
  porTributo,
  esquemaTributo,
  xmlCliente,
  xmlLinea,
} = require('./sunat.boleta');

/**
 * @param {object} datos
 * @param {{ ruc: string, razonSocial: string, nombreComercial?: string, establecimiento?: string }} datos.emisor
 * @param {string} datos.serie   `BC01`
 * @param {number} datos.numero
 * @param {Date}   datos.fecha
 * @param {'PEN'|'USD'} [datos.moneda]
 * @param {{ serie: string, numero: number }} datos.referencia  la boleta que anula
 * @param {string} datos.motivo  texto libre del porqué
 * @param {object} datos.cliente  el mismo de la boleta
 * @param {object[]} datos.items  las mismas líneas de la boleta
 */
function construirNotaCredito(datos) {
  const { emisor, serie, numero, fecha = new Date(), moneda = 'PEN', referencia, motivo, cliente, items } = datos;

  if (!/^\d{11}$/.test(emisor?.ruc ?? '')) throw new Error('El RUC del emisor debe tener 11 dígitos.');
  if (!/^B[A-Z0-9]{3}$/.test(serie ?? '')) throw new Error('La serie de una nota que anula una boleta empieza por B.');
  if (!Number.isInteger(numero) || numero < 1 || numero > 99999999) throw new Error('Número fuera de rango.');
  if (!/^B[A-Z0-9]{3}$/.test(referencia?.serie ?? '') || !Number.isInteger(referencia?.numero)) {
    throw new Error('Falta la boleta que se anula.');
  }
  if (!motivo?.trim()) throw new Error('Falta el motivo de la anulación.');
  if (!MONEDA[moneda]) throw new Error(`Moneda no admitida: ${moneda}`);
  if (!Object.values(TIPO_DOCUMENTO).includes(cliente?.tipoDocumento)) {
    throw new Error(`Tipo de documento del cliente no admitido: ${cliente?.tipoDocumento}`);
  }
  if (!Array.isArray(items) || items.length === 0) throw new Error('La nota necesita al menos un ítem.');

  const lineas = items.map((item) => ({ ...partirLinea(item), afectacionCodigo: String(item.afectacion) }));
  const total = lineas.reduce((suma, l) => suma + l.total, 0);
  const valor = lineas.reduce((suma, l) => suma + l.valor, 0);
  const igv = lineas.reduce((suma, l) => suma + l.igv, 0);
  const { dia, hora } = fechaLima(fecha);
  const m = `currencyID="${moneda}"`;
  const nombreLegal = escapar(emisor.razonSocial);
  const citada = `${referencia.serie}-${referencia.numero}`;

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"' +
    ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"' +
    ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"' +
    ' xmlns:ds="http://www.w3.org/2000/09/xmldsig#"' +
    ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">' +
    '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>' +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID>' +
    '<cbc:CustomizationID>2.0</cbc:CustomizationID>' +
    `<cbc:ID>${serie}-${numero}</cbc:ID>` +
    `<cbc:IssueDate>${dia}</cbc:IssueDate>` +
    `<cbc:IssueTime>${hora}</cbc:IssueTime>` +
    `<cbc:Note languageLocaleID="1000">${montoEnLetras(total, moneda)}</cbc:Note>` +
    `<cbc:DocumentCurrencyCode>${moneda}</cbc:DocumentCurrencyCode>` +
    '<cac:DiscrepancyResponse>' +
    `<cbc:ReferenceID>${citada}</cbc:ReferenceID>` +
    `<cbc:ResponseCode>${MOTIVO_NOTA_CREDITO.ANULACION}</cbc:ResponseCode>` +
    `<cbc:Description>${escapar(motivo.trim())}</cbc:Description>` +
    '</cac:DiscrepancyResponse>' +
    '<cac:BillingReference><cac:InvoiceDocumentReference>' +
    `<cbc:ID>${citada}</cbc:ID>` +
    `<cbc:DocumentTypeCode>${TIPO_COMPROBANTE.BOLETA}</cbc:DocumentTypeCode>` +
    '</cac:InvoiceDocumentReference></cac:BillingReference>' +
    '<cac:Signature>' +
    `<cbc:ID>${ID_FIRMA}</cbc:ID>` +
    '<cac:SignatoryParty>' +
    `<cac:PartyIdentification><cbc:ID>${emisor.ruc}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyName><cbc:Name>${nombreLegal}</cbc:Name></cac:PartyName>` +
    '</cac:SignatoryParty>' +
    `<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#${ID_FIRMA}</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>` +
    '</cac:Signature>' +
    '<cac:AccountingSupplierParty><cac:Party>' +
    `<cac:PartyIdentification><cbc:ID schemeID="6">${emisor.ruc}</cbc:ID></cac:PartyIdentification>` +
    (emisor.nombreComercial
      ? `<cac:PartyName><cbc:Name>${escapar(emisor.nombreComercial)}</cbc:Name></cac:PartyName>`
      : '') +
    '<cac:PartyLegalEntity>' +
    `<cbc:RegistrationName>${nombreLegal}</cbc:RegistrationName>` +
    `<cac:RegistrationAddress><cbc:AddressTypeCode>${emisor.establecimiento ?? '0000'}</cbc:AddressTypeCode></cac:RegistrationAddress>` +
    '</cac:PartyLegalEntity>' +
    '</cac:Party></cac:AccountingSupplierParty>' +
    xmlCliente(cliente) +
    '<cac:TaxTotal>' +
    `<cbc:TaxAmount ${m}>${decimal(igv)}</cbc:TaxAmount>` +
    porTributo(lineas)
      .map(
        (grupo) =>
          '<cac:TaxSubtotal>' +
          `<cbc:TaxableAmount ${m}>${decimal(grupo.valor)}</cbc:TaxableAmount>` +
          `<cbc:TaxAmount ${m}>${decimal(grupo.igv)}</cbc:TaxAmount>` +
          `<cac:TaxCategory>${esquemaTributo(grupo.afectacion)}</cac:TaxCategory>` +
          '</cac:TaxSubtotal>',
      )
      .join('') +
    '</cac:TaxTotal>' +
    '<cac:LegalMonetaryTotal>' +
    `<cbc:LineExtensionAmount ${m}>${decimal(valor)}</cbc:LineExtensionAmount>` +
    `<cbc:TaxInclusiveAmount ${m}>${decimal(total)}</cbc:TaxInclusiveAmount>` +
    `<cbc:PayableAmount ${m}>${decimal(total)}</cbc:PayableAmount>` +
    '</cac:LegalMonetaryTotal>' +
    lineas.map((linea, i) => xmlLinea(linea, i, moneda, 'CreditNote')).join('') +
    '</CreditNote>';

  return {
    nombre: nombreDelArchivo(emisor.ruc, serie, numero, TIPO_COMPROBANTE.NOTA_CREDITO),
    xml,
    totales: { total, valor, igv, moneda },
  };
}

module.exports = { construirNotaCredito };
