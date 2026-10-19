'use strict';

/**
 * Manda una boleta de prueba al ambiente BETA de SUNAT y enseña qué contestó.
 *
 *   node scripts/sunat-probar-beta.js [afectacion] [tipoOperacion]
 *   node scripts/sunat-probar-beta.js 20 0113
 *
 * La beta no tiene efecto tributario: acepta cualquier RUC con el usuario
 * MODDATOS / moddatos y un certificado de prueba, que aquí se genera al vuelo.
 * Con SUNAT_PFX y SUNAT_PFX_CLAVE en el entorno usa ese certificado en su
 * lugar (para comprobar uno real antes de pasar a producción).
 *
 * El número de la boleta sale de la hora, para que dos pruebas seguidas no
 * choquen con «ya fue presentado». Guarda el XML firmado y la CDR en la
 * carpeta temporal del sistema.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const forge = require('node-forge');
const { construirBoleta } = require('../src/modules/sunat/sunat.boleta');
const { leerCertificado, firmar } = require('../src/modules/sunat/sunat.firma');
const { enviarComprobante } = require('../src/modules/sunat/sunat.envio');

const RUC = process.env.SUNAT_RUC || '10720995960';

function certificadoDePrueba() {
  const llaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = llaves.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  const nombre = [{ name: 'commonName', value: `PRUEBA ${RUC}` }, { name: 'countryName', value: 'PE' }];
  cert.setSubject(nombre);
  cert.setIssuer(nombre);
  cert.sign(llaves.privateKey, forge.md.sha256.create());
  return {
    llavePem: forge.pki.privateKeyToPem(llaves.privateKey),
    certificadoPem: forge.pki.certificateToPem(cert),
  };
}

async function main() {
  const [afectacion = '10', tipoOperacion = '0101'] = process.argv.slice(2);
  const certificado = process.env.SUNAT_PFX
    ? leerCertificado({ pfx: fs.readFileSync(process.env.SUNAT_PFX), clave: process.env.SUNAT_PFX_CLAVE })
    : certificadoDePrueba();

  const numero = Date.now() % 99999999;
  const boleta = construirBoleta({
    emisor: { ruc: RUC, razonSocial: 'ACOSTA ENRIQUEZ BENICIO GONZALO', nombreComercial: 'Acosta | IA & Research' },
    serie: 'B001',
    numero,
    tipoOperacion,
    cliente: { tipoDocumento: '1', numeroDocumento: '12345678', nombre: 'CLIENTE DE PRUEBA' },
    items: [{ codigo: 'METODO', descripcion: 'Método de Tesis (prueba)', cantidad: 1, precioUnitario: 15900, afectacion }],
  });
  const xmlFirmado = firmar(boleta.xml, certificado);

  const resultado = await enviarComprobante({
    nombre: boleta.nombre,
    xmlFirmado,
    credenciales: { ruc: RUC, usuario: 'MODDATOS', clave: 'moddatos' },
    ambiente: 'beta',
  });

  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'sunat-beta-'));
  fs.writeFileSync(path.join(carpeta, `${boleta.nombre}.xml`), xmlFirmado);
  if (resultado.cdrZip) fs.writeFileSync(path.join(carpeta, `R-${boleta.nombre}.zip`), resultado.cdrZip);

  const { cdrZip, ...resumen } = resultado;
  console.log(JSON.stringify({ boleta: boleta.nombre, afectacion, tipoOperacion, ...resumen, carpeta }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
