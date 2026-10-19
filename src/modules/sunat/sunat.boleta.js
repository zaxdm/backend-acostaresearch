'use strict';

/**
 * Arma la boleta de venta electrónica en UBL 2.1, el XML que pide SUNAT.
 *
 * Recibe todo por parámetro (emisor, serie, número, cliente, ítems) y no toca
 * la base ni la configuración: el correlativo, el tipo de cambio y quién es el
 * emisor los decide quien llama. Devuelve el XML todavía sin firmar, con el
 * hueco de la firma (`ext:ExtensionContent`) vacío.
 *
 * Los importes entran en céntimos enteros, como en `payments.amountCents`,
 * para no arrastrar errores de coma flotante; solo se pasan a «159.90» al
 * escribir el XML.
 */

const { TIPO_COMPROBANTE, AFECTACION, TIPO_OPERACION, TIPO_DOCUMENTO, MONEDA } = require('./sunat.catalogos');
const { montoEnLetras } = require('./sunat.letras');

/** Id de la firma: el `cac:Signature` de la boleta apunta a él. */
const ID_FIRMA = 'SignatureAR';

/** Perú no tiene horario de verano: siempre UTC−5. */
const LIMA_MS = -5 * 60 * 60 * 1000;

function escapar(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `15990` → `159.90`. */
function decimal(centimos) {
  const signo = centimos < 0 ? '-' : '';
  const abs = Math.abs(centimos);
  return `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Fecha y hora de emisión en Lima, como las pide SUNAT. */
function fechaLima(fecha) {
  const iso = new Date(fecha.getTime() + LIMA_MS).toISOString();
  return { dia: iso.slice(0, 10), hora: iso.slice(11, 19) };
}

/** Nombre del archivo: `RUC-03-B001-123`, sin extensión. */
function nombreDelArchivo(ruc, serie, numero) {
  return `${ruc}-${TIPO_COMPROBANTE.BOLETA}-${serie}-${numero}`;
}

/**
 * Valor e IGV de una línea cuyo precio ya incluye el impuesto. En gravado el
 * precio se parte en base + IGV; en lo demás el IGV es cero.
 */
function partirLinea(item) {
  const afectacion = AFECTACION[item.afectacion];
  if (!afectacion) throw new Error(`Afectación de IGV no admitida: ${item.afectacion}`);
  if (!Number.isInteger(item.precioUnitario) || item.precioUnitario <= 0) {
    throw new Error(`Precio no válido en «${item.descripcion}»`);
  }
  if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
    throw new Error(`Cantidad no válida en «${item.descripcion}»`);
  }
  const total = item.precioUnitario * item.cantidad;
  const valor = Math.round((total * 100) / (100 + afectacion.porcentaje));
  return { ...item, afectacion, total, valor, igv: total - valor };
}

function validar({ emisor, serie, numero, cliente, items, moneda }) {
  if (!/^\d{11}$/.test(emisor?.ruc ?? '')) throw new Error('El RUC del emisor debe tener 11 dígitos.');
  if (!emisor.razonSocial) throw new Error('Falta la razón social del emisor.');
  if (!/^B[A-Z0-9]{3}$/.test(serie ?? '')) throw new Error('La serie de una boleta empieza por B y tiene 4 caracteres.');
  if (!Number.isInteger(numero) || numero < 1 || numero > 99999999) throw new Error('Número fuera de rango.');
  if (!MONEDA[moneda]) throw new Error(`Moneda no admitida: ${moneda}`);
  if (!Object.values(TIPO_DOCUMENTO).includes(cliente?.tipoDocumento)) {
    throw new Error(`Tipo de documento del cliente no admitido: ${cliente?.tipoDocumento}`);
  }
  if (!Array.isArray(items) || items.length === 0) throw new Error('La boleta necesita al menos un ítem.');
}

/** Los totales de impuestos agrupados por tributo, como pide el `cac:TaxTotal`. */
function porTributo(lineas) {
  const grupos = new Map();
  for (const linea of lineas) {
    const clave = linea.afectacion.tributo;
    const grupo = grupos.get(clave) ?? { afectacion: linea.afectacion, valor: 0, igv: 0 };
    grupo.valor += linea.valor;
    grupo.igv += linea.igv;
    grupos.set(clave, grupo);
  }
  return [...grupos.values()];
}

function esquemaTributo(afectacion) {
  return (
    '<cac:TaxScheme>' +
    `<cbc:ID>${afectacion.tributo}</cbc:ID>` +
    `<cbc:Name>${afectacion.nombre}</cbc:Name>` +
    `<cbc:TaxTypeCode>${afectacion.tipo}</cbc:TaxTypeCode>` +
    '</cac:TaxScheme>'
  );
}

function xmlCliente(cliente) {
  const numero = cliente.numeroDocumento || '-';
  const nombre = cliente.nombre || 'CLIENTES VARIOS';
  const pais = cliente.pais
    ? '<cac:RegistrationAddress><cac:AddressLine><cbc:Line>' +
      escapar(cliente.pais) +
      '</cbc:Line></cac:AddressLine></cac:RegistrationAddress>'
    : '';
  return (
    '<cac:AccountingCustomerParty><cac:Party>' +
    `<cac:PartyIdentification><cbc:ID schemeID="${escapar(cliente.tipoDocumento)}">${escapar(numero)}</cbc:ID></cac:PartyIdentification>` +
    `<cac:PartyLegalEntity><cbc:RegistrationName>${escapar(nombre)}</cbc:RegistrationName>${pais}</cac:PartyLegalEntity>` +
    '</cac:Party></cac:AccountingCustomerParty>'
  );
}

function xmlLinea(linea, indice, moneda) {
  const m = `currencyID="${moneda}"`;
  const valorUnitario = Math.round(linea.valor / linea.cantidad);
  return (
    '<cac:InvoiceLine>' +
    `<cbc:ID>${indice + 1}</cbc:ID>` +
    `<cbc:InvoicedQuantity unitCode="ZZ">${linea.cantidad}</cbc:InvoicedQuantity>` +
    `<cbc:LineExtensionAmount ${m}>${decimal(linea.valor)}</cbc:LineExtensionAmount>` +
    '<cac:PricingReference><cac:AlternativeConditionPrice>' +
    `<cbc:PriceAmount ${m}>${decimal(linea.precioUnitario)}</cbc:PriceAmount>` +
    '<cbc:PriceTypeCode>01</cbc:PriceTypeCode>' +
    '</cac:AlternativeConditionPrice></cac:PricingReference>' +
    '<cac:TaxTotal>' +
    `<cbc:TaxAmount ${m}>${decimal(linea.igv)}</cbc:TaxAmount>` +
    '<cac:TaxSubtotal>' +
    `<cbc:TaxableAmount ${m}>${decimal(linea.valor)}</cbc:TaxableAmount>` +
    `<cbc:TaxAmount ${m}>${decimal(linea.igv)}</cbc:TaxAmount>` +
    '<cac:TaxCategory>' +
    `<cbc:Percent>${linea.afectacion.porcentaje}</cbc:Percent>` +
    `<cbc:TaxExemptionReasonCode>${linea.afectacionCodigo}</cbc:TaxExemptionReasonCode>` +
    esquemaTributo(linea.afectacion) +
    '</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>' +
    '<cac:Item>' +
    `<cbc:Description>${escapar(linea.descripcion)}</cbc:Description>` +
    (linea.codigo ? `<cac:SellersItemIdentification><cbc:ID>${escapar(linea.codigo)}</cbc:ID></cac:SellersItemIdentification>` : '') +
    '</cac:Item>' +
    `<cac:Price><cbc:PriceAmount ${m}>${decimal(valorUnitario)}</cbc:PriceAmount></cac:Price>` +
    '</cac:InvoiceLine>'
  );
}

/**
 * @param {object} datos
 * @param {{ ruc: string, razonSocial: string, nombreComercial?: string, establecimiento?: string }} datos.emisor
 * @param {string} datos.serie   `B001`
 * @param {number} datos.numero  correlativo, sin ceros a la izquierda
 * @param {Date}   datos.fecha
 * @param {'PEN'|'USD'} [datos.moneda]
 * @param {string} [datos.tipoOperacion]  catálogo 51
 * @param {{ tipoDocumento: string, numeroDocumento?: string, nombre?: string, pais?: string }} datos.cliente
 * @param {{ descripcion: string, codigo?: string, cantidad: number, precioUnitario: number, afectacion: string }[]} datos.items
 *   `precioUnitario` en céntimos e impuestos incluidos.
 */
function construirBoleta(datos) {
  const {
    emisor,
    serie,
    numero,
    fecha = new Date(),
    moneda = 'PEN',
    tipoOperacion = TIPO_OPERACION.VENTA_INTERNA,
    cliente,
    items,
  } = datos;
  validar({ emisor, serie, numero, cliente, items, moneda });

  const lineas = items.map((item) => ({ ...partirLinea(item), afectacionCodigo: String(item.afectacion) }));
  const total = lineas.reduce((suma, l) => suma + l.total, 0);
  const valor = lineas.reduce((suma, l) => suma + l.valor, 0);
  const igv = lineas.reduce((suma, l) => suma + l.igv, 0);
  const { dia, hora } = fechaLima(fecha);
  const m = `currencyID="${moneda}"`;
  const nombreLegal = escapar(emisor.razonSocial);

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"' +
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
    `<cbc:InvoiceTypeCode listID="${tipoOperacion}">${TIPO_COMPROBANTE.BOLETA}</cbc:InvoiceTypeCode>` +
    `<cbc:Note languageLocaleID="1000">${montoEnLetras(total, moneda)}</cbc:Note>` +
    `<cbc:DocumentCurrencyCode>${moneda}</cbc:DocumentCurrencyCode>` +
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
    lineas.map((linea, i) => xmlLinea(linea, i, moneda)).join('') +
    '</Invoice>';

  return {
    nombre: nombreDelArchivo(emisor.ruc, serie, numero),
    xml,
    totales: { total, valor, igv, moneda },
  };
}

module.exports = { construirBoleta, nombreDelArchivo, ID_FIRMA, decimal, fechaLima };
