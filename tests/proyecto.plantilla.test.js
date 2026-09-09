'use strict';

/**
 * La plantilla de la universidad.
 *
 * Lo que se prueba: que de un .docx solo salga la hoja de estilos, que los
 * archivos que no lo son se rechacen con un mensaje que el tesista entienda, y
 * —lo más importante— que **el contenido del documento no se quede en ninguna
 * parte**. Esas plantillas suelen venir con la tesis de otro dentro.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const {
  extraerEstilos,
  estilosQueTrae,
  PlantillaNoValida,
} = require('../src/modules/projects/project.plantilla');

const ESTILOS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
  '<w:rPr><w:rFonts w:ascii="Arial"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '</w:styles>';

/** Un .docx creíble, con una tesis ajena dentro del documento. */
function docxDePrueba({ conEstilos = true } = {}) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from('<w:document>TESIS DE OTRA PERSONA — datos personales de Fulano</w:document>'),
  );
  if (conEstilos) zip.addFile('word/styles.xml', Buffer.from(ESTILOS_XML));
  return zip.toBuffer();
}

test('de un .docx sale su hoja de estilos', () => {
  const xml = extraerEstilos(docxDePrueba());

  assert.match(xml, /<w:styles/);
  assert.match(xml, /Arial/);
});

test('el contenido del documento NO viaja con los estilos', () => {
  // Es lo que más importa de todo el módulo: esas plantillas vienen con
  // ejemplos, con el nombre de otro tesista, a veces con una tesis entera.
  const xml = extraerEstilos(docxDePrueba());

  assert.ok(!xml.includes('TESIS DE OTRA PERSONA'));
  assert.ok(!xml.includes('Fulano'));
});

test('se puede decir qué estilos trae, para que compruebe si subió el bueno', () => {
  const nombres = estilosQueTrae(extraerEstilos(docxDePrueba()));

  assert.deepEqual(nombres.sort(), ['Heading1', 'Normal']);
});

test('un .doc antiguo se rechaza diciendo qué hacer', () => {
  const doc = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]);

  assert.throws(
    () => extraerEstilos(doc),
    (e) => {
      assert.ok(e instanceof PlantillaNoValida);
      assert.match(e.message, /guárdala como/i);
      return true;
    },
  );
});

test('un zip que no es un documento de Word se rechaza', () => {
  const zip = new AdmZip();
  zip.addFile('cualquier.txt', Buffer.from('hola'));

  assert.throws(() => extraerEstilos(zip.toBuffer()), PlantillaNoValida);
});

test('un .docx sin estilos definidos se rechaza explicando por qué', () => {
  assert.throws(
    () => extraerEstilos(docxDePrueba({ conEstilos: false })),
    (e) => {
      assert.match(e.message, /no trae estilos/i);
      return true;
    },
  );
});

test('un archivo vacío no revienta', () => {
  assert.throws(() => extraerEstilos(Buffer.alloc(0)), PlantillaNoValida);
  assert.throws(() => extraerEstilos(null), PlantillaNoValida);
});

test('un archivo demasiado grande se rechaza antes de intentar abrirlo', () => {
  const enorme = Buffer.alloc(6 * 1024 * 1024, 0x50);

  assert.throws(
    () => extraerEstilos(enorme),
    (e) => {
      assert.match(e.message, /no tu tesis/i);
      return true;
    },
  );
});
