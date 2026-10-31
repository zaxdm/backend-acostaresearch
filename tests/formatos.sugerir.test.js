'use strict';

/**
 * La ficha que se lee de la portada de un formato (31-oct): universidad,
 * siglas, facultad y grado, para no escribirlos a mano al aprobar lo que suben
 * los tesistas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { sugerir, comoNombre } = require('../src/modules/formatos/formato.sugerir');

function docx(parrafos, cabecera = null) {
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from(`<w:document><w:body>${parrafos.map(p).join('')}</w:body></w:document>`));
  if (cabecera) zip.addFile('word/header1.xml', Buffer.from(`<w:hdr>${p(cabecera)}</w:hdr>`));
  return zip.toBuffer();
}

test('la portada de San Marcos da nombre, sigla, facultad y grado', () => {
  const archivo = docx([
    'UNIVERSIDAD NACIONAL MAYOR DE SAN MARCOS',
    'Universidad del Perú. Decana de América',
    'FACULTAD DE CIENCIAS ADMINISTRATIVAS',
    'Escuela Profesional de Administración',
    'Proyecto de tesis para optar el Título Profesional de Licenciado en Administración',
    'AUTOR: Juan Pérez',
  ]);
  assert.deepEqual(sugerir(archivo, 'FORMATO DE PROYECTO UNMSM.docx'), {
    universidad: 'Universidad Nacional Mayor de San Marcos',
    alias: 'UNMSM',
    facultad: 'Facultad de Ciencias Administrativas',
    grado: 'pregrado',
  });
});

test('si ya está en la biblioteca, se copia su nombre y sus otros nombres', () => {
  const biblioteca = [{ universidad: 'Universidad César Vallejo', alias: 'UCV, César Vallejo' }];
  const archivo = docx(['ESCUELA DE POSGRADO', 'PROGRAMA ACADÉMICO DE MAESTRÍA EN EDUCACIÓN']);
  // Sin nombre en la portada: lo encuentra por la sigla del archivo.
  assert.deepEqual(sugerir(archivo, 'plantilla UCV 2026.docx', biblioteca), {
    universidad: 'Universidad César Vallejo',
    alias: 'UCV, César Vallejo',
    facultad: '',
    grado: 'posgrado',
  });
  // Con el nombre escrito distinto, se queda el de la biblioteca.
  const conNombre = docx(['UNIVERSIDAD CÉSAR VALLEJO']);
  assert.equal(sugerir(conNombre, 'x.docx', biblioteca).universidad, 'Universidad César Vallejo');
});

test('el nombre puede ir en la cabecera, y lo que va detrás se corta', () => {
  const archivo = docx(['Título de la tesis'], 'Universidad Privada del Norte – Lima');
  const ficha = sugerir(archivo, 'formato tesis UPN.docx');
  assert.equal(ficha.universidad, 'Universidad Privada del Norte');
  assert.equal(ficha.alias, 'UPN');
});

test('una frase que menciona la universidad no es su nombre, y sin nada queda vacío', () => {
  const archivo = docx(['La investigación se realizó en la universidad de la ciudad con 200 estudiantes.']);
  assert.deepEqual(sugerir(archivo, 'FORMATO FINAL APA.docx'), { universidad: '', alias: '', facultad: '', grado: '' });
  assert.deepEqual(sugerir(Buffer.from('no es un zip'), ''), { universidad: '', alias: '', facultad: '', grado: '' });
});

test('solo se pasa a minúsculas lo que venía todo en mayúsculas', () => {
  assert.equal(comoNombre('UNIVERSIDAD NACIONAL DE SAN AGUSTÍN DE AREQUIPA'), 'Universidad Nacional de San Agustín de Arequipa');
  assert.equal(comoNombre('Universidad ESAN'), 'Universidad ESAN');
});
