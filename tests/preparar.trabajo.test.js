'use strict';

/**
 * Lo que se entrega y lo que no.
 *
 * En la primera prueba real, una edición devolvió el MISMO documento que se
 * había subido —cero párrafos tocados— y se entregó como buena, gastando un
 * documento del mes. Eso es cobrar por nada, y es justo lo que este archivo
 * impide: si no se cambió ni un párrafo, el trabajo sale por el camino del
 * fallo, que no gasta cupo y le explica al cliente qué pasó.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docx(texto) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>` +
        `<w:p><w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>` +
        '</w:body></w:document>',
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));
  return zip.toBuffer();
}

const ENTRADA = docx('The access to technology shows a clear improvement in most homes.');

/** La fila de la preparación, tal y como la va dejando el servicio. */
let fila;
let guardados;
let propuesta;
let correos;

falsificar('../src/modules/preparar/preparar.repository', {
  marcar: async (id, campos) => {
    fila = { ...fila, ...campos };
    return fila;
  },
  duenoDe: async () => ({ user: { id: 'u1', email: 'tesista@ejemplo.pe', firstName: 'Esteban' } }),
  listarDe: async () => [],
});

falsificar('../src/modules/preparar/preparar.storage', {
  leerEntrada: async () => ENTRADA,
  guardarSalida: async (id, buffer) => {
    guardados.push(buffer);
  },
  haySalida: async () => true,
});

falsificar('../src/modules/preparar/preparar.motor', {
  prepararParrafos: async () => propuesta,
  resumenDe: async () => {
    throw new Error('no toca');
  },
});

falsificar('../src/lib/mailer', {
  sendMail: async (mensaje) => {
    correos.push(mensaje);
  },
});

const prepararService = require('../src/modules/preparar/preparar.service');

const ID = '11111111-1111-4111-8111-111111111111';

test.beforeEach(() => {
  fila = {
    id: ID,
    servicio: 'EDICION',
    idioma: null,
    nombre: 'tesis.docx',
    palabras: 11,
    estado: 'EN_COLA',
  };
  guardados = [];
  correos = [];
  propuesta = { cambios: {}, malos: [] };
});

test('una edición que no cambió ni un párrafo NO se entrega', async () => {
  await prepararService.trabajar(ID);

  assert.equal(fila.estado, 'FALLIDO');
  assert.match(fila.error, /no te hemos descontado ningún documento/i);
  assert.equal(guardados.length, 0, 'no se guarda un documento idéntico al que subió');
});

test('y se le dice por correo, no en silencio', async () => {
  await prepararService.trabajar(ID);

  assert.equal(correos.length, 1);
  assert.equal(correos[0].to, 'tesista@ejemplo.pe');
});

test('una traducción que no tradujo nada tampoco se entrega', async () => {
  fila.servicio = 'TRADUCCION';
  fila.idioma = 'en';

  await prepararService.trabajar(ID);

  assert.equal(fila.estado, 'FALLIDO');
  assert.match(fila.error, /No hemos podido traducir/i);
});

test('con un solo párrafo corregido, sí se entrega', async () => {
  propuesta = {
    cambios: {
      1: {
        original: 'The access to technology shows a clear improvement in most homes.',
        texto: 'The access to technology showed a clear improvement in most homes.',
      },
    },
    malos: [],
  };

  await prepararService.trabajar(ID);

  assert.equal(fila.estado, 'LISTO');
  assert.equal(fila.tocados, 1);
  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].subarray(0, 2).toString(), 'PK');
});
