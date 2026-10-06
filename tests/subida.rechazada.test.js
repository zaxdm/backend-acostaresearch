'use strict';

/**
 * Las subidas rechazadas: qué se le dice al tesista y el aviso al móvil.
 *
 * Salió de un tesista que quiso subir 80 PDF al enlace de R cuando solo
 * aceptaba Excel: nadie se enteró hasta que lo contó (6-oct-2026).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

// El aviso se cambia por uno que solo apunta, antes de cargar nada que lo use.
const avisos = [];
const rutaNotify = require.resolve('../src/lib/notify');
require.cache[rutaNotify] = {
  id: rutaNotify,
  filename: rutaNotify,
  loaded: true,
  exports: { avisarAlAdmin: (a) => avisos.push(a), avisarAlProgramador: () => {} },
};

const { claveDe, claveDeCabecera } = require('../src/lib/tipoDeArchivo');
const rechazo = require('../src/lib/subidaRechazada');
const errorHandler = require('../src/middlewares/errorHandler');
const { ValidationError, ForbiddenError } = require('../src/shared/errors/AppError');

function zipCon(nombres) {
  const zip = new AdmZip();
  for (const n of nombres) zip.addFile(n, Buffer.from('<x/>'));
  return zip.toBuffer();
}

// ── Qué archivo es ──────────────────────────────────────────────────────────

test('se reconoce cada tipo por sus bytes, no por el nombre', () => {
  assert.equal(claveDe(Buffer.from('%PDF-1.7\n...')), 'pdf');
  assert.equal(claveDe(zipCon(['[Content_Types].xml', 'word/document.xml'])), 'docx');
  assert.equal(claveDe(zipCon(['[Content_Types].xml', 'xl/workbook.xml'])), 'xlsx');
  assert.equal(claveDe(zipCon(['[Content_Types].xml', 'ppt/presentation.xml'])), 'pptx');
  assert.equal(claveDe(zipCon(['Index/Document.iwa'])), 'iwork', 'un .pages de Apple');
  assert.equal(claveDe(zipCon(['data/CAB01.pdf'])), 'zip');
  assert.equal(claveDe(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), 'ole');
  assert.equal(claveDe(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'imagen');
  assert.equal(claveDe(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])), 'heic');
  assert.equal(claveDe(Buffer.from('{\\rtf1\\ansi')), 'rtf');
  assert.equal(claveDe(Buffer.from('id;sexo\n1;F\n')), 'texto');
  assert.equal(claveDe(Buffer.from('<!DOCTYPE html><html>')), 'html');
  assert.equal(claveDe(Buffer.alloc(0)), null);
  assert.equal(claveDeCabecera('application/pdf'), 'pdf');
  assert.equal(claveDeCabecera('application/octet-stream'), null, 'la de casi todas las páginas no dice nada');
});

// ── El mensaje para el tesista ──────────────────────────────────────────────

test('un tipo que no se acepta ahí: qué es, qué se acepta y cómo convertirlo', () => {
  const avance = rechazo.subidaDe('/api/v1/proyectos/METODO_9_SKILLS/avance');
  const m = rechazo.mensajeParaElUsuario(avance, { clave: 'iwork', nombre: 'un documento de Pages o Numbers (Apple)', pista: 'Expórtalo a Word.' });
  assert.equal(m, 'Eso es un documento de Pages o Numbers (Apple) y aquí no lo aceptamos. Aquí se sube: Word (.docx). Expórtalo a Word.');
});

test('un tipo que sí se acepta deja el mensaje de la ruta, que sabe qué tiene por dentro', () => {
  const avance = rechazo.subidaDe('/api/v1/proyectos/X/avance');
  assert.equal(rechazo.mensajeParaElUsuario(avance, { clave: 'docx', nombre: 'un Word' }), null);
});

test('la lista de lo que se acepta se lee bien', () => {
  assert.equal(rechazo.listaDe(['docx']), 'Word (.docx)');
  assert.equal(rechazo.listaDe(['docx', 'pdf', 'texto']), 'Word (.docx), PDF o CSV o texto');
});

// ── De punta a punta por el manejador de errores ────────────────────────────

function respuesta() {
  const res = { estado: null, cuerpo: null, set() {} };
  res.status = (s) => {
    res.estado = s;
    return res;
  };
  res.json = (c) => {
    res.cuerpo = c;
    return res;
  };
  return res;
}

const peticion = (url, body, cabeceras = {}) => ({
  method: 'POST',
  originalUrl: url,
  body,
  headers: { 'content-type': 'application/octet-stream', 'content-length': String(body?.length ?? 0), ...cabeceras },
});

test('un PDF al avance del panel: el tesista lee qué pasa y llega un aviso', () => {
  rechazo.olvidarAvisos();
  avisos.length = 0;
  const res = respuesta();
  errorHandler(
    new ValidationError('Eso no es un .docx.'),
    peticion('/api/v1/proyectos/METODO_9_SKILLS/avance', Buffer.from('%PDF-1.7 ...')),
    res,
    () => {},
  );
  assert.equal(res.estado, 422);
  assert.match(res.cuerpo.error.message, /^Eso es un PDF y aquí no lo aceptamos\. Aquí se sube: Word \(\.docx\)\./);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].titulo, /Avance de tesis/);
  assert.match(avisos[0].mensaje, /un PDF/);
});

test('los reintentos del mismo rechazo no mandan cinco avisos', () => {
  rechazo.olvidarAvisos();
  avisos.length = 0;
  for (let i = 0; i < 5; i += 1) {
    errorHandler(
      new ValidationError('x'),
      peticion('/api/v1/r/subir/abc', Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
      respuesta(),
      () => {},
    );
  }
  assert.equal(avisos.length, 1);
});

test('un archivo que pesa de más ya no es «Ocurrió un error inesperado»', () => {
  rechazo.olvidarAvisos();
  avisos.length = 0;
  const demasiado = Object.assign(new Error('request entity too large'), {
    type: 'entity.too.large',
    status: 413,
    limit: 40 * 1024 * 1024,
  });
  const res = respuesta();
  errorHandler(demasiado, peticion('/api/v1/preparar/corregir', undefined, { 'content-length': '50000000' }), res, () => {});
  assert.equal(res.estado, 413);
  assert.match(res.cuerpo.error.message, /pesa demasiado: aquí el máximo es 40,0 MB/);
  assert.equal(avisos.length, 1);
});

test('lo que no es un archivo mal subido no avisa: licencia vencida, JSON, administrador', () => {
  rechazo.olvidarAvisos();
  avisos.length = 0;
  errorHandler(new ForbiddenError('Tu licencia no está vigente'), peticion('/api/v1/r/subir/abc', Buffer.from('%PDF-')), respuesta(), () => {});
  errorHandler(
    new ValidationError('Falta el título'),
    { method: 'POST', originalUrl: '/api/v1/proyectos/X/tesis', body: { titulo: '' }, headers: { 'content-type': 'application/json', 'content-length': '12' } },
    respuesta(),
    () => {},
  );
  errorHandler(
    new ValidationError('x'),
    { ...peticion('/api/v1/proyectos/X/avance', Buffer.from('%PDF-')), user: { role: 'ADMIN' } },
    respuesta(),
    () => {},
  );
  assert.equal(avisos.length, 0);
});
