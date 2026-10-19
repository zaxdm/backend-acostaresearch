'use strict';

/**
 * Firma digital de la boleta (XMLDSig «enveloped», como pide SUNAT).
 *
 * La firma va dentro de `ext:ExtensionContent`, abarca el documento entero
 * (`URI=""`) y publica el certificado en `KeyInfo`, que es de donde SUNAT lo
 * lee para comprobarla.
 *
 * Los certificados digitales en Perú se venden como `.pfx` (PKCS#12) con
 * contraseña. Node no sabe abrir ese formato; por eso `leerCertificado` usa
 * node-forge y devuelve la llave y el certificado en PEM.
 */

const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { ID_FIRMA } = require('./sunat.boleta');

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

/**
 * Llave y certificado en PEM, desde un `.pfx` con su contraseña o desde los
 * dos PEM ya separados.
 *
 * @param {{ pfx?: Buffer, clave?: string, llavePem?: string, certificadoPem?: string }} origen
 * @returns {{ llavePem: string, certificadoPem: string, vence: Date | null }}
 */
function leerCertificado(origen) {
  if (origen.llavePem && origen.certificadoPem) {
    return { llavePem: origen.llavePem, certificadoPem: origen.certificadoPem, vence: null };
  }
  if (!origen.pfx) throw new Error('Falta el certificado digital (.pfx o los dos PEM).');

  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(origen.pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, origen.clave ?? '');
  } catch {
    throw new Error('No se pudo abrir el certificado: revisa el archivo .pfx y su contraseña.');
  }
  const llaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certificados = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  if (!llaves[0]?.key || certificados.length === 0) {
    throw new Error('El .pfx no trae la llave privada y el certificado juntos.');
  }

  // Si el .pfx trae la cadena entera, el certificado que firma es el que
  // corresponde a la llave (mismo módulo RSA), no necesariamente el primero.
  const llave = llaves[0].key;
  const propio =
    certificados.find((bolsa) => bolsa.cert?.publicKey?.n?.equals?.(llave.n))?.cert ?? certificados[0].cert;

  return {
    llavePem: forge.pki.privateKeyToPem(llave),
    certificadoPem: forge.pki.certificateToPem(propio),
    vence: propio.validity?.notAfter ?? null,
  };
}

/**
 * Devuelve el XML con la firma puesta. El XML de entrada tiene que traer el
 * `ext:ExtensionContent` vacío que deja `construirBoleta`.
 */
function firmar(xml, { llavePem, certificadoPem }) {
  const firma = new SignedXml({
    privateKey: llavePem,
    publicCert: certificadoPem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
  });
  firma.addReference({
    xpath: '/*',
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA256,
    isEmptyUri: true,
  });
  firma.computeSignature(xml, {
    prefix: 'ds',
    attrs: { Id: ID_FIRMA },
    location: { reference: "//*[local-name(.)='ExtensionContent']", action: 'append' },
    existingPrefixes: { ds: 'http://www.w3.org/2000/09/xmldsig#' },
  });
  return firma.getSignedXml();
}

/** El resumen (DigestValue) que va en el QR y en la representación impresa. */
function resumenDeLaFirma(xmlFirmado) {
  return /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(xmlFirmado)?.[1] ?? null;
}

module.exports = { leerCertificado, firmar, resumenDeLaFirma };
