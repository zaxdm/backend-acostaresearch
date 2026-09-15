'use strict';

/**
 * Un .docx que miente sobre su tamaño no llega a descomprimirse.
 *
 * adm-zip descomprime sin techo una entrada que declara 0 bytes, y ese número lo
 * escribe quien fabrica el archivo. Lo que se prueba: que eso sigue siendo
 * verdad en la versión instalada —si un día deja de serlo, la prueba lo dice—,
 * que `abrirZip` lo rechaza antes de tocar los datos, que la plantilla lo
 * convierte en el mensaje de siempre para el tesista, y que un Word de verdad,
 * con un archivo vacío dentro, sigue abriéndose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { abrirZip, ZipSospechoso } = require('../src/modules/projects/project.zip');
const plantilla = require('../src/modules/projects/project.plantilla');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const FIRMA_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/** Un .docx mínimo con un document.xml que comprime muchísimo. */
function docx({ relleno = 0, vacio = false } = {}) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  const cuerpo = `<w:document xmlns:w="${W}"><w:body><w:p/>${' '.repeat(relleno)}</w:body></w:document>`;
  zip.addFile('word/document.xml', Buffer.from(cuerpo));
  zip.addFile('word/styles.xml', Buffer.from(`<w:styles xmlns:w="${W}"></w:styles>`));
  if (vacio) zip.addFile('word/vacio.xml', Buffer.alloc(0));
  return zip.toBuffer();
}

/** Reescribe en el directorio central el tamaño que declara una entrada. */
function declararCero(buffer, nombre) {
  const copia = Buffer.from(buffer);
  for (let i = copia.indexOf(FIRMA_CENTRAL); i !== -1; i = copia.indexOf(FIRMA_CENTRAL, i + 4)) {
    const largo = copia.readUInt16LE(i + 28);
    if (copia.toString('utf8', i + 46, i + 46 + largo) === nombre) copia.writeUInt32LE(0, i + 24);
  }
  return copia;
}

const DOS_MEGAS = 2 * 1024 * 1024;

test('adm-zip, a pelo, descomprime entera una entrada que dice pesar 0 bytes', () => {
  const bomba = declararCero(docx({ relleno: DOS_MEGAS }), 'word/document.xml');
  const entrada = new AdmZip(bomba).getEntry('word/document.xml');

  assert.equal(entrada.header.size, 0);
  assert.ok(entrada.getData().length > DOS_MEGAS, 'si esto falla, adm-zip ya pone techo solo');
});

test('abrirZip la rechaza sin descomprimir nada', () => {
  const bomba = declararCero(docx({ relleno: DOS_MEGAS }), 'word/document.xml');
  assert.throws(() => abrirZip(bomba), ZipSospechoso);
});

test('la plantilla la convierte en el mensaje de siempre para el tesista', () => {
  const bomba = declararCero(docx({ relleno: DOS_MEGAS }), 'word/document.xml');
  assert.throws(() => plantilla.extraerEstilos(bomba), plantilla.PlantillaNoValida);
  // Las lecturas que nunca lanzan tampoco la abren: devuelven lo de reserva.
  assert.equal(plantilla.extraerPagina(bomba), null);
});

test('un Word de verdad se abre, aunque lleve un archivo vacío dentro', () => {
  const zip = abrirZip(docx({ relleno: 1000, vacio: true }));
  assert.ok(zip.getEntry('word/document.xml').getData().toString('utf8').includes('<w:body>'));
  assert.equal(zip.getEntry('word/vacio.xml').getData().length, 0);
  assert.ok(plantilla.extraerEstilos(docx()).includes('<w:styles'));
});
