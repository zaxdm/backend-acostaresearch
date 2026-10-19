'use strict';

/**
 * Facturador SUNAT, fase 1 (17-oct-2026): armar, firmar y enviar la boleta.
 *
 * Lo que se fija: el monto en letras, que los totales cuadran en céntimos
 * (gravado parte el precio en base + IGV; exonerado no), que la firma se
 * comprueba y deja de comprobarse si se toca el XML, que el .pfx se abre con
 * su contraseña y no sin ella, y cómo se lee cada respuesta de SUNAT. Nada
 * aquí llama a SUNAT: las respuestas se arman en la prueba. Contra la beta
 * real está `scripts/sunat-probar-beta.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

const { montoEnLetras } = require('../src/modules/sunat/sunat.letras');
const { construirBoleta } = require('../src/modules/sunat/sunat.boleta');
const { leerCertificado, firmar, resumenDeLaFirma } = require('../src/modules/sunat/sunat.firma');
const { enviarComprobante, leerRespuesta, ESTADO } = require('../src/modules/sunat/sunat.envio');

const EMISOR = { ruc: '10720995960', razonSocial: 'ACOSTA ENRIQUEZ BENICIO GONZALO' };

function certificado() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const llave = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01');
  cert.validity.notAfter = new Date('2027-01-01');
  cert.setSubject([{ name: 'commonName', value: 'PRUEBA' }]);
  cert.setIssuer([{ name: 'commonName', value: 'PRUEBA' }]);
  cert.sign(llave, forge.md.sha256.create());
  return { llave, cert, llavePem: forge.pki.privateKeyToPem(llave), certificadoPem: forge.pki.certificateToPem(cert) };
}

const CERT = certificado();

function boleta(extra = {}) {
  return construirBoleta({
    emisor: EMISOR,
    serie: 'B001',
    numero: 7,
    fecha: new Date('2026-10-17T15:30:00Z'),
    cliente: { tipoDocumento: '1', numeroDocumento: '12345678', nombre: 'Ana Pérez' },
    items: [{ codigo: 'METODO', descripcion: 'Método de Tesis', cantidad: 1, precioUnitario: 15900, afectacion: '20' }],
    ...extra,
  });
}

test('monto en letras', () => {
  assert.equal(montoEnLetras(15990, 'PEN'), 'SON CIENTO CINCUENTA Y NUEVE CON 90/100 SOLES');
  assert.equal(montoEnLetras(10000, 'PEN'), 'SON CIEN CON 00/100 SOLES');
  assert.equal(montoEnLetras(100000, 'USD'), 'SON MIL CON 00/100 DÓLARES AMERICANOS');
  assert.equal(montoEnLetras(2100050, 'PEN'), 'SON VEINTIUN MIL CON 50/100 SOLES');
  assert.equal(montoEnLetras(100000000, 'PEN'), 'SON UN MILLÓN CON 00/100 SOLES');
  assert.equal(montoEnLetras(5, 'PEN'), 'SON CERO CON 05/100 SOLES');
  assert.throws(() => montoEnLetras(100, 'EUR'), /Moneda/);
  assert.throws(() => montoEnLetras(1.5, 'PEN'), /Importe/);
});

test('boleta exonerada: el total es el precio y el IGV es cero', () => {
  const { nombre, xml, totales } = boleta();
  assert.equal(nombre, '10720995960-03-B001-7');
  assert.deepEqual(totales, { total: 15900, valor: 15900, igv: 0, moneda: 'PEN' });
  assert.match(xml, /<cbc:ID>B001-7<\/cbc:ID>/);
  assert.match(xml, /<cbc:IssueDate>2026-10-17<\/cbc:IssueDate><cbc:IssueTime>10:30:00<\/cbc:IssueTime>/);
  assert.match(xml, /<cbc:InvoiceTypeCode listID="0101">03<\/cbc:InvoiceTypeCode>/);
  assert.match(xml, /SON CIENTO CINCUENTA Y NUEVE CON 00\/100 SOLES/);
  assert.match(xml, /<cbc:ID>9997<\/cbc:ID><cbc:Name>EXO<\/cbc:Name>/);
  assert.match(xml, /<cbc:PayableAmount currencyID="PEN">159.00<\/cbc:PayableAmount>/);
  assert.match(xml, /<ext:ExtensionContent><\/ext:ExtensionContent>/);
});

test('boleta gravada: el precio se parte en base + IGV y cuadra al céntimo', () => {
  const { xml, totales } = boleta({
    items: [
      { descripcion: 'Uno', cantidad: 1, precioUnitario: 15900, afectacion: '10' },
      { descripcion: 'Dos', cantidad: 3, precioUnitario: 1990, afectacion: '10' },
    ],
  });
  assert.equal(totales.total, 15900 + 5970);
  assert.equal(totales.valor + totales.igv, totales.total);
  assert.equal(totales.valor, 13475 + 5059);
  assert.match(xml, /<cbc:ID>1000<\/cbc:ID><cbc:Name>IGV<\/cbc:Name>/);
  assert.match(xml, /<cbc:Percent>18<\/cbc:Percent>/);
});

test('cliente varios, extranjero con país y texto con caracteres de XML', () => {
  const varios = boleta({ cliente: { tipoDocumento: '-' } }).xml;
  assert.match(varios, /<cbc:ID schemeID="-">-<\/cbc:ID>/);
  assert.match(varios, /CLIENTES VARIOS/);

  const fuera = boleta({
    moneda: 'USD',
    tipoOperacion: '0113',
    cliente: { tipoDocumento: '0', numeroDocumento: '-', nombre: 'Ruiz & <Hijos>', pais: 'MÉXICO' },
  }).xml;
  assert.match(fuera, /Ruiz &amp; &lt;Hijos&gt;/);
  assert.match(fuera, /<cbc:Line>MÉXICO<\/cbc:Line>/);
  assert.match(fuera, /currencyID="USD"/);
  assert.match(fuera, /listID="0113"/);
});

test('rechaza datos que SUNAT no aceptaría, antes de enviar', () => {
  assert.throws(() => boleta({ serie: 'F001' }), /serie/);
  assert.throws(() => boleta({ emisor: { ...EMISOR, ruc: '123' } }), /RUC/);
  assert.throws(() => boleta({ items: [] }), /ítem/);
  assert.throws(() => boleta({ cliente: { tipoDocumento: '9' } }), /documento/);
  assert.throws(
    () => boleta({ items: [{ descripcion: 'X', cantidad: 1, precioUnitario: 100, afectacion: '99' }] }),
    /Afectación/,
  );
  assert.throws(
    () => boleta({ items: [{ descripcion: 'X', cantidad: 1, precioUnitario: 1.5, afectacion: '20' }] }),
    /Precio/,
  );
});

test('la firma va en ExtensionContent, se comprueba y se rompe si se altera el XML', () => {
  const firmado = firmar(boleta().xml, CERT);
  assert.match(firmado, /<ext:ExtensionContent><ds:Signature[^>]*Id="SignatureAR"/);
  assert.match(firmado, /<ds:Reference URI="">/);
  assert.match(firmado, /<ds:X509Certificate>/);
  assert.ok(resumenDeLaFirma(firmado));

  const comprobar = (xml) => {
    const verificador = new SignedXml({ publicCert: CERT.certificadoPem });
    const nodo = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(xml)[0];
    verificador.loadSignature(nodo);
    try {
      return verificador.checkSignature(xml);
    } catch {
      return false;
    }
  };
  assert.equal(comprobar(firmado), true);
  assert.equal(comprobar(firmado.replace('>159.00<', '>169.00<')), false);
});

test('el .pfx se abre con su contraseña y no sin ella', () => {
  const asn1 = forge.pkcs12.toPkcs12Asn1(CERT.llave, [CERT.cert], 'clave-123', { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

  const leido = leerCertificado({ pfx, clave: 'clave-123' });
  assert.equal(leido.certificadoPem.replace(/\r/g, ''), CERT.certificadoPem.replace(/\r/g, ''));
  assert.equal(leido.vence.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.throws(() => leerCertificado({ pfx, clave: 'otra' }), /contraseña/);
  assert.throws(() => leerCertificado({}), /Falta el certificado/);
});

function sobreConCdr({ codigo, descripcion, notas = [] }) {
  const cdr =
    '<ar:ApplicationResponse xmlns:ar="urn:x" xmlns:cbc="urn:cbc" xmlns:cac="urn:cac">' +
    notas.map((n) => `<cbc:Note>${n}</cbc:Note>`).join('') +
    '<cac:DocumentResponse><cac:Response>' +
    `<cbc:ResponseCode>${codigo}</cbc:ResponseCode><cbc:Description>${descripcion}</cbc:Description>` +
    '</cac:Response></cac:DocumentResponse></ar:ApplicationResponse>';
  const zip = new AdmZip();
  zip.addFile('R-10720995960-03-B001-7.xml', Buffer.from(cdr));
  return (
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>' +
    `<br:sendBillResponse xmlns:br="http://service.sunat.gob.pe"><applicationResponse>${zip.toBuffer().toString('base64')}</applicationResponse></br:sendBillResponse>` +
    '</soap-env:Body></soap-env:Envelope>'
  );
}

function sobreConFault(codigo, texto) {
  return (
    '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body><soap-env:Fault>' +
    `<faultcode>soap-env:Client.${codigo}</faultcode><faultstring>${texto}</faultstring>` +
    '</soap-env:Fault></soap-env:Body></soap-env:Envelope>'
  );
}

test('cómo se lee cada respuesta de SUNAT', () => {
  const aceptada = leerRespuesta(sobreConCdr({ codigo: 0, descripcion: 'La Boleta numero B001-7, ha sido aceptada' }));
  assert.equal(aceptada.estado, ESTADO.ACEPTADO);
  assert.equal(aceptada.codigo, 0);
  assert.ok(Buffer.isBuffer(aceptada.cdrZip));

  const observada = leerRespuesta(sobreConCdr({ codigo: 0, descripcion: 'aceptada', notas: ['4252 - Falta dirección'] }));
  assert.equal(observada.estado, ESTADO.OBSERVADO);
  assert.deepEqual(observada.observaciones, ['4252 - Falta dirección']);

  const rechazada = leerRespuesta(sobreConFault('2335', 'El documento electr&#243;nico ingresado ha sido alterado'));
  assert.equal(rechazada.estado, ESTADO.RECHAZADO);
  assert.equal(rechazada.descripcion, 'El documento electrónico ingresado ha sido alterado');

  const usuario = leerRespuesta(sobreConFault('0111', 'No tiene el perfil para enviar comprobantes'));
  assert.equal(usuario.estado, ESTADO.EXCEPCION);
  assert.equal(usuario.yaPresentado, false);

  assert.equal(leerRespuesta(sobreConFault('1033', 'Registrado previamente')).yaPresentado, true);
  assert.equal(leerRespuesta('<html>502</html>').estado, ESTADO.SIN_RESPUESTA);
});

test('el envío: usuario RUC+SOL, ZIP con el XML y la red caída no lanza', async () => {
  let peticion;
  const resultado = await enviarComprobante({
    nombre: '10720995960-03-B001-7',
    xmlFirmado: '<Invoice/>',
    credenciales: { ruc: '10720995960', usuario: 'MODDATOS', clave: 'moddatos' },
    fetchFn: async (url, opciones) => {
      peticion = { url, ...opciones };
      return { text: async () => sobreConCdr({ codigo: 0, descripcion: 'aceptada' }) };
    },
  });
  assert.equal(resultado.estado, ESTADO.ACEPTADO);
  assert.match(peticion.url, /e-beta\.sunat\.gob\.pe/);
  assert.match(peticion.body, /<wsse:Username>10720995960MODDATOS<\/wsse:Username>/);
  assert.match(peticion.body, /<fileName>10720995960-03-B001-7\.zip<\/fileName>/);
  const contenido = /<contentFile>([^<]+)<\/contentFile>/.exec(peticion.body)[1];
  const entradas = new AdmZip(Buffer.from(contenido, 'base64')).getEntries();
  assert.deepEqual(entradas.map((e) => e.entryName), ['10720995960-03-B001-7.xml']);

  const caida = await enviarComprobante({
    nombre: 'x',
    xmlFirmado: '<Invoice/>',
    credenciales: { ruc: '1', usuario: 'u', clave: 'c' },
    fetchFn: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(caida.estado, ESTADO.SIN_RESPUESTA);
  assert.match(caida.descripcion, /ECONNRESET/);

  await assert.rejects(
    enviarComprobante({ nombre: 'x', xmlFirmado: '', credenciales: {}, ambiente: 'otro' }),
    /Ambiente/,
  );
});
