'use strict';

/**
 * Envío de un comprobante firmado a SUNAT (SEE – Del Contribuyente).
 *
 * El protocolo es SOAP: el XML firmado va dentro de un ZIP, el ZIP en base64
 * dentro del sobre `sendBill`, y el usuario es el RUC seguido del usuario SOL
 * secundario. SUNAT contesta con otro ZIP, la Constancia de Recepción (CDR),
 * que es la prueba de que aceptó o rechazó la boleta y hay que guardarla.
 *
 * Cómo se lee la respuesta (manual del programador de SUNAT):
 *  - CDR con código 0: aceptada.
 *  - CDR con código 4000 o más: aceptada con observaciones.
 *  - CDR con código 2000–3999, o un fault con ese código: rechazada. La
 *    boleta no vale; se corrige y se emite con otro número.
 *  - Fault con código menor a 2000: excepción (usuario mal puesto, servicio
 *    caído, ya presentado…). La boleta no llegó a evaluarse.
 *  - Sin respuesta (red, tiempo agotado): no se sabe; se vuelve a intentar.
 */

const AdmZip = require('adm-zip');
const { SERVICIO } = require('./sunat.catalogos');

/** Si SUNAT no contesta en este tiempo se aborta y la boleta queda pendiente. */
const ESPERA_MS = 30 * 1000;

const ESTADO = {
  ACEPTADO: 'ACEPTADO',
  OBSERVADO: 'OBSERVADO',
  RECHAZADO: 'RECHAZADO',
  EXCEPCION: 'EXCEPCION',
  SIN_RESPUESTA: 'SIN_RESPUESTA',
};

/** Error 1033: «El comprobante fue registrado previamente con otros datos». */
const YA_PRESENTADO = new Set([1032, 1033]);

function escaparXml(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** El ZIP que se envía: un solo XML con el mismo nombre que el ZIP. */
function empaquetar(nombre, xmlFirmado) {
  const zip = new AdmZip();
  zip.addFile(`${nombre}.xml`, Buffer.from(xmlFirmado, 'utf8'));
  return zip.toBuffer();
}

function sobreSendBill({ usuario, clave, archivo, contenido }) {
  return (
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' xmlns:ser="http://service.sunat.gob.pe"' +
    ' xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    '<soapenv:Header><wsse:Security><wsse:UsernameToken>' +
    `<wsse:Username>${escaparXml(usuario)}</wsse:Username>` +
    `<wsse:Password>${escaparXml(clave)}</wsse:Password>` +
    '</wsse:UsernameToken></wsse:Security></soapenv:Header>' +
    '<soapenv:Body><ser:sendBill>' +
    `<fileName>${archivo}</fileName>` +
    `<contentFile>${contenido}</contentFile>` +
    '</ser:sendBill></soapenv:Body></soapenv:Envelope>'
  );
}

/** SUNAT escribe «electr&#243;nico»: se devuelve legible. */
function desescapar(texto) {
  if (texto == null) return texto;
  const nombradas = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, nombre) => nombradas[nombre]);
}

/** El texto de la primera etiqueta con ese nombre local, sin importar el prefijo. */
function etiqueta(xml, nombre) {
  return new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`).exec(xml)?.[1]?.trim() ?? null;
}

function todas(xml, nombre) {
  const patron = new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`, 'g');
  return [...xml.matchAll(patron)].map((m) => m[1].trim());
}

/** Lee la CDR (ZIP en base64) y la convierte en un resultado. */
function leerCdr(base64) {
  const cdrZip = Buffer.from(base64, 'base64');
  const entrada = new AdmZip(cdrZip).getEntries().find((e) => /\.xml$/i.test(e.entryName));
  if (!entrada) throw new Error('La CDR de SUNAT no trae XML.');
  const cdrXml = entrada.getData().toString('utf8');
  const respuesta = etiqueta(cdrXml, 'DocumentResponse') ?? cdrXml;
  const codigo = Number(etiqueta(respuesta, 'ResponseCode'));
  const descripcion = desescapar(etiqueta(respuesta, 'Description'));
  const observaciones = todas(cdrXml, 'Note').map(desescapar);
  let estado = ESTADO.ACEPTADO;
  if (codigo >= 2000 && codigo < 4000) estado = ESTADO.RECHAZADO;
  else if (codigo >= 4000 || observaciones.length > 0) estado = ESTADO.OBSERVADO;
  return { estado, codigo, descripcion, observaciones, cdrZip };
}

/** `soap-env:Client.0111` → 111. */
function codigoDelFault(faultcode) {
  const numero = /(\d+)\s*$/.exec(faultcode ?? '')?.[1];
  return numero ? Number(numero) : null;
}

/**
 * Lee la respuesta HTTP de SUNAT. Exportada para poder probarla con
 * respuestas guardadas sin llamar a SUNAT.
 */
function leerRespuesta(cuerpo) {
  const cdr = etiqueta(cuerpo, 'applicationResponse');
  if (cdr) return leerCdr(cdr);

  const faultcode = etiqueta(cuerpo, 'faultcode');
  if (faultcode) {
    const codigo = codigoDelFault(faultcode);
    const descripcion = desescapar(etiqueta(cuerpo, 'faultstring') ?? etiqueta(cuerpo, 'message'));
    const rechazo = codigo >= 2000 && codigo < 4000;
    return {
      estado: rechazo ? ESTADO.RECHAZADO : ESTADO.EXCEPCION,
      codigo,
      descripcion,
      observaciones: [],
      cdrZip: null,
      yaPresentado: YA_PRESENTADO.has(codigo),
    };
  }
  return {
    estado: ESTADO.SIN_RESPUESTA,
    codigo: null,
    descripcion: 'SUNAT respondió algo que no es ni CDR ni error.',
    observaciones: [],
    cdrZip: null,
  };
}

/**
 * Envía la boleta firmada y devuelve el resultado. Nunca lanza por culpa de
 * SUNAT: un fallo de red o un tiempo agotado vuelve como `SIN_RESPUESTA`, para
 * que quien llama decida si reintenta.
 *
 * @param {object} p
 * @param {string} p.nombre       `RUC-03-B001-123`
 * @param {string} p.xmlFirmado
 * @param {{ ruc: string, usuario: string, clave: string }} p.credenciales  usuario SOL secundario
 * @param {'beta'|'produccion'} [p.ambiente]
 * @param {typeof fetch} [p.fetchFn]  para las pruebas
 */
async function enviarComprobante({ nombre, xmlFirmado, credenciales, ambiente = 'beta', fetchFn = fetch }) {
  const url = SERVICIO[ambiente];
  if (!url) throw new Error(`Ambiente de SUNAT desconocido: ${ambiente}`);

  const zip = empaquetar(nombre, xmlFirmado);
  const sobre = sobreSendBill({
    usuario: `${credenciales.ruc}${credenciales.usuario}`,
    clave: credenciales.clave,
    archivo: `${nombre}.zip`,
    contenido: zip.toString('base64'),
  });

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), ESPERA_MS);
  try {
    const respuesta = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:sendBill' },
      body: sobre,
      signal: control.signal,
    });
    const resultado = leerRespuesta(await respuesta.text());
    // Un 401 o un 503 de su nginx no trae ni CDR ni fault: que el motivo se lea.
    if (resultado.estado === ESTADO.SIN_RESPUESTA && !respuesta.ok) {
      resultado.descripcion = `SUNAT respondió HTTP ${respuesta.status}.`;
    }
    return resultado;
  } catch (error) {
    return {
      estado: ESTADO.SIN_RESPUESTA,
      codigo: null,
      descripcion: error.name === 'AbortError' ? 'SUNAT no respondió a tiempo.' : `No se pudo llegar a SUNAT: ${error.message}`,
      observaciones: [],
      cdrZip: null,
    };
  } finally {
    clearTimeout(reloj);
  }
}

module.exports = { enviarComprobante, leerRespuesta, empaquetar, ESTADO };
