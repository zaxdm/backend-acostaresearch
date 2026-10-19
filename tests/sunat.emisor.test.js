'use strict';

/**
 * Facturador SUNAT, fase 2 (19-oct-2026): de cada venta cobrada, su boleta.
 *
 * Lo que se fija: qué ventas llevan boleta (el carrito es una sola, el canje de
 * un código no cuenta), que todo va gravado con el IGV dentro del precio y en
 * soles, el tope de S/700 sin documento, que una venta nunca recibe dos
 * boletas, que los números no se repiten, y qué se hace con cada respuesta de
 * SUNAT (aceptada, rechazada, sin respuesta, ya presentada). Sin base ni
 * SUNAT: los dos se simulan aquí.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');

const { ventasParaBoleta, datosDeBoleta } = require('../src/modules/sunat/sunat.ventas');
const tipoCambio = require('../src/modules/sunat/sunat.tipoCambio');
const { crearEmisor, AVISAR_TRAS_INTENTOS } = require('../src/modules/sunat/sunat.service');
const { ESTADO } = require('../src/modules/sunat/sunat.envio');

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
  return { llavePem: forge.pki.privateKeyToPem(llave), certificadoPem: forge.pki.certificateToPem(cert) };
}

const CERT = certificado();
const ANA = { firstName: 'Ana', lastName: 'Pérez', pais: 'PE' };

function pago(extra = {}) {
  return {
    id: 'p1',
    cartId: null,
    providerOrderId: 'ORD-1',
    amountCents: 15900,
    currency: 'PEN',
    paidAt: new Date('2026-10-20T15:00:00Z'),
    plan: { name: 'Método de Tesis', code: 'METODO', productCode: 'METODO' },
    user: ANA,
    ...extra,
  };
}

// ── Qué ventas llevan boleta ────────────────────────────────────────────────

test('un carrito es una sola boleta; el canje de un código no cuenta; el código vendido sí', () => {
  const ventas = ventasParaBoleta({
    pagos: [
      pago({ id: 'a', cartId: 'C1' }),
      pago({ id: 'b', cartId: 'C1', plan: { name: 'Humanizador', code: 'HUM' }, amountCents: 3400 }),
      pago({ id: 'canje', providerOrderId: 'cod-9' }),
      pago({ id: 'suelto' }),
    ],
    codigos: [{ id: 'cod-1', productCode: 'METODO', amountCents: 15900, createdAt: new Date('2026-10-20T16:00:00Z') }],
    idsDeCodigos: new Set(['cod-9']),
    nombresDeProducto: { METODO: 'Método de Tesis' },
  });

  assert.deepEqual(
    ventas.map((v) => v.origenClave).sort(),
    ['CARRITO:C1', 'CODIGO:cod-1', 'PAGO:suelto'],
  );
  const carrito = ventas.find((v) => v.origenClave === 'CARRITO:C1');
  assert.equal(carrito.items.length, 2);
  assert.equal(ventas.find((v) => v.origenClave === 'CODIGO:cod-1').cliente.nombre, 'CLIENTES VARIOS');
});

test('todo gravado con IGV dentro del precio y en soles; el extranjero va como no domiciliado', () => {
  const [peruana] = ventasParaBoleta({ pagos: [pago()], codigos: [] });
  const datos = datosDeBoleta(peruana, null);
  assert.equal(datos.moneda, 'PEN');
  assert.deepEqual(datos.items, [
    { codigo: 'METODO', descripcion: 'Método de Tesis', cantidad: 1, precioUnitario: 15900, afectacion: '10' },
  ]);
  assert.equal(datos.cliente.tipoDocumento, '-');
  assert.equal(datos.cliente.nombre, 'Ana Pérez');

  const [fuera] = ventasParaBoleta({
    pagos: [pago({ currency: 'USD', amountCents: 2600, user: { firstName: 'Luis', lastName: 'Ruiz', pais: 'mx' } })],
    codigos: [],
  });
  const enDolares = datosDeBoleta(fuera, 3.431);
  assert.equal(enDolares.items[0].precioUnitario, 8921); // 26 × 3.431 = 89.206
  assert.equal(enDolares.monedaOriginal, 'USD');
  assert.equal(enDolares.importeOriginalCents, 2600);
  assert.equal(enDolares.tipoCambio, 3.431);
  assert.equal(enDolares.cliente.tipoDocumento, '0');
  assert.equal(enDolares.cliente.pais, 'MÉXICO');
  assert.equal(enDolares.clientePais, 'MX');

  assert.throws(() => datosDeBoleta(fuera, null), /tipo de cambio/);
});

test('sin documento no pasa de S/700; monedas raras o mezcladas tampoco', () => {
  const [grande] = ventasParaBoleta({
    pagos: [pago({ id: 'x', cartId: 'C', amountCents: 39900 }), pago({ id: 'y', cartId: 'C', amountCents: 39900 })],
    codigos: [],
  });
  assert.throws(() => datosDeBoleta(grande, null), /S\/700/);

  const [real] = ventasParaBoleta({ pagos: [pago({ currency: 'BRL' })], codigos: [] });
  assert.throws(() => datosDeBoleta(real, null), /BRL/);

  const [mezcla] = ventasParaBoleta({
    pagos: [pago({ id: 'x', cartId: 'M' }), pago({ id: 'y', cartId: 'M', currency: 'USD' })],
    codigos: [],
  });
  assert.throws(() => datosDeBoleta(mezcla, 3.4), /mezcla/);
});

test('tipo de cambio: lee el texto de SUNAT y usa el del día o el último', () => {
  assert.deepEqual(tipoCambio.leerTexto('19/10/2026|3.423|3.431|\n'), { fecha: '2026-10-19', venta: 3.431 });
  assert.equal(tipoCambio.leerTexto('<html>error</html>'), null);

  tipoCambio._leidos.clear();
  assert.equal(tipoCambio.para('2026-10-19'), null);
  tipoCambio._leidos.set('2026-10-18', 3.4);
  tipoCambio._leidos.set('2026-10-19', 3.431);
  assert.equal(tipoCambio.para('2026-10-18'), 3.4);
  assert.equal(tipoCambio.para('2026-10-20'), 3.431);
  tipoCambio._leidos.clear();
});

// ── El emisor, con base y SUNAT simulados ───────────────────────────────────

function repoEnMemoria() {
  const filas = [];
  const series = new Map();
  return {
    filas,
    async clavesConBoleta(claves) {
      return new Set(filas.filter((f) => claves.includes(f.origenClave)).map((f) => f.origenClave));
    },
    async pendientes(limite) {
      return filas.filter((f) => f.estado === 'PENDIENTE').slice(0, limite).map((f) => ({ ...f }));
    },
    async crearConNumero(serie, armar) {
      const numero = (series.get(serie) ?? 0) + 1;
      const data = armar(numero);
      if (filas.some((f) => f.origenClave === data.origenClave)) {
        throw Object.assign(new Error('duplicado'), { code: 'P2002' });
      }
      series.set(serie, numero);
      const fila = { id: `c${numero}`, estado: 'PENDIENTE', intentos: 0, ...data };
      filas.push(fila);
      return { ...fila };
    },
    async actualizar(id, data) {
      Object.assign(filas.find((f) => f.id === id), data);
    },
  };
}

function emisorDePrueba({ ventas, respuestas = [], activo = true }) {
  const repo = repoEnMemoria();
  const avisos = [];
  const enviados = [];
  const emisor = crearEmisor({
    repo,
    ventas: async () => ventas,
    cambio: { actualizar: async () => null, para: () => 3.431 },
    enviar: async (envio) => {
      enviados.push(envio);
      return respuestas.shift() ?? { estado: ESTADO.ACEPTADO, codigo: 0, descripcion: 'aceptada', observaciones: [], cdrZip: Buffer.from('cdr') };
    },
    cargarCertificado: () => CERT,
    avisar: (aviso) => avisos.push(aviso),
    log: { info() {}, error() {} },
    pausa: 0,
    config: {
      activo,
      ambiente: 'beta',
      desde: new Date('2026-10-20T00:00:00-05:00'),
      ruc: '10720995960',
      razonSocial: 'ACOSTA ENRIQUEZ BENICIO GONZALO',
      nombreComercial: 'Acosta | IA & Research',
      serie: 'B001',
      usuario: 'FACTURA1',
      clave: 'x',
    },
  });
  return { emisor, repo, avisos, enviados };
}

test('apagado no hace nada', async () => {
  const { emisor, enviados } = emisorDePrueba({ ventas: ventasParaBoleta({ pagos: [pago()], codigos: [] }), activo: false });
  assert.equal(await emisor.pasada(), null);
  assert.equal(enviados.length, 0);
});

test('emite, numera seguido, firma y no repite la boleta de una venta', async () => {
  const ventas = ventasParaBoleta({ pagos: [pago({ id: 'a' }), pago({ id: 'b' })], codigos: [] });
  const { emisor, repo, enviados } = emisorDePrueba({ ventas });

  assert.deepEqual(await emisor.pasada(), { reenviadas: 0, emitidas: 2, sinBoleta: 0 });
  assert.deepEqual(repo.filas.map((f) => `${f.serie}-${f.numero}`), ['B001-1', 'B001-2']);
  assert.ok(repo.filas.every((f) => f.estado === 'ACEPTADO'));
  assert.equal(enviados[0].nombre, '10720995960-03-B001-1');
  assert.equal(enviados[0].credenciales.usuario, 'FACTURA1');

  const [primera] = repo.filas;
  assert.equal(primera.totalCents, 15900);
  assert.equal(primera.valorCents + primera.igvCents, 15900);
  assert.equal(primera.igvCents, 2425);
  assert.ok(primera.hash);
  const verificar = new SignedXml({ publicCert: CERT.certificadoPem });
  verificar.loadSignature(/<ds:Signature[\s\S]*<\/ds:Signature>/.exec(primera.xmlFirmado)[0]);
  assert.equal(verificar.checkSignature(primera.xmlFirmado), true);

  // Segunda pasada con las mismas ventas: nada nuevo.
  assert.deepEqual(await emisor.pasada(), { reenviadas: 0, emitidas: 0, sinBoleta: 0 });
  assert.equal(repo.filas.length, 2);
});

test('sin respuesta: sigue pendiente, se reenvía el mismo XML y se avisa a los N intentos', async () => {
  const sinRespuesta = () => ({ estado: ESTADO.SIN_RESPUESTA, codigo: null, descripcion: 'SUNAT no respondió a tiempo.' });
  const { emisor, repo, avisos, enviados } = emisorDePrueba({
    ventas: ventasParaBoleta({ pagos: [pago()], codigos: [] }),
    respuestas: Array.from({ length: AVISAR_TRAS_INTENTOS }, sinRespuesta),
  });

  for (let i = 0; i < AVISAR_TRAS_INTENTOS; i += 1) await emisor.pasada();
  assert.equal(repo.filas.length, 1);
  assert.equal(repo.filas[0].estado, 'PENDIENTE');
  assert.equal(repo.filas[0].intentos, AVISAR_TRAS_INTENTOS);
  assert.ok(enviados.every((e) => e.xmlFirmado === enviados[0].xmlFirmado));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].titulo, /no llega a SUNAT/);

  // La siguiente la acepta.
  await emisor.pasada();
  assert.equal(repo.filas[0].estado, 'ACEPTADO');
});

test('rechazada o ya presentada: avisa y no se reenvía', async () => {
  const { emisor, repo, avisos } = emisorDePrueba({
    ventas: ventasParaBoleta({ pagos: [pago({ id: 'a' }), pago({ id: 'b' })], codigos: [] }),
    respuestas: [
      { estado: ESTADO.RECHAZADO, codigo: 2017, descripcion: 'El número de documento no es válido' },
      { estado: ESTADO.EXCEPCION, codigo: 1033, descripcion: 'registrado previamente', yaPresentado: true },
    ],
  });
  await emisor.pasada();
  assert.deepEqual(repo.filas.map((f) => f.estado), ['RECHAZADO', 'REVISAR']);
  assert.equal(avisos.length, 2);

  await emisor.pasada();
  assert.equal(repo.filas.length, 2);
  assert.equal(avisos.length, 2);
});

test('una venta que no puede llevar boleta no gasta número y se avisa una sola vez', async () => {
  const ventas = ventasParaBoleta({
    pagos: [pago({ id: 'x', cartId: 'C', amountCents: 39900 }), pago({ id: 'y', cartId: 'C', amountCents: 39900 }), pago({ id: 'ok' })],
    codigos: [],
  });
  const { emisor, repo, avisos } = emisorDePrueba({ ventas });

  assert.deepEqual(await emisor.pasada(), { reenviadas: 0, emitidas: 1, sinBoleta: 1 });
  await emisor.pasada();
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].mensaje, /CARRITO:C/);
  assert.deepEqual(repo.filas.map((f) => f.numero), [1]);
});

test('un 401 de SUNAT sin CDR queda pendiente y dice el código HTTP', async () => {
  const { enviarComprobante } = require('../src/modules/sunat/sunat.envio');
  const r = await enviarComprobante({
    nombre: '10720995960-03-B001-1',
    xmlFirmado: '<Invoice/>',
    credenciales: { ruc: '10720995960', usuario: 'FACTURA1', clave: 'x' },
    fetchFn: async () => ({ ok: false, status: 401, text: async () => '<html>401 Authorization Required</html>' }),
  });
  assert.equal(r.estado, ESTADO.SIN_RESPUESTA);
  assert.equal(r.descripcion, 'SUNAT respondió HTTP 401.');
});
