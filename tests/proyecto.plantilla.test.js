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
  extraerPagina,
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

test('el Word armado con la plantilla lleva SUS títulos, no los de la librería', async () => {
  // El caso real: la librería metía su «Heading1» azul delante del de la
  // plantilla, y Word se quedaba con el primero. Los títulos de la facultad no
  // se aplicaban nunca.
  const { armar } = require('../src/modules/projects/project.docx');

  const buffer = await armar({
    tema: 'Prueba',
    estilos: ESTILOS_XML,
    capitulos: [{ titulo: 'Capítulo I', texto: '## Antecedentes\n\nTexto.' }],
  });

  const styles = new AdmZip(buffer).getEntry('word/styles.xml').getData().toString('utf8');
  const titulos1 = [...styles.matchAll(/<w:style\s[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/g)];

  assert.equal(titulos1.length, 1, 'una sola definición de Título 1');
  assert.match(titulos1[0][0], /Arial/, 'y es la de la plantilla');
  assert.doesNotMatch(titulos1[0][0], /2E74B5/, 'no la azul de la librería');
});

/** Un .docx con la sección de página: A4 y márgenes de 2,5 / 3 / 2,5 / 4 cm. */
function docxConPagina(sectPr) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<w:document><w:body><w:p>TEXTO AJENO</w:p>${sectPr}</w:body></w:document>`),
  );
  zip.addFile('word/styles.xml', Buffer.from(ESTILOS_XML));
  return zip.toBuffer();
}

const SECCION_A4 =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1417" w:right="1701" w:bottom="-1417" w:left="2268" w:header="709" ' +
  'w:footer="709" w:gutter="0"/></w:sectPr>';

test('de la plantilla salen sus márgenes y su tamaño de página, y nada del texto', () => {
  const pagina = extraerPagina(docxConPagina(SECCION_A4));

  assert.deepEqual(pagina, {
    margen: { top: 1417, right: 1701, bottom: 1417, left: 2268, header: 709, footer: 709, gutter: 0 },
    tamano: { width: 11906, height: 16838 },
  });
  assert.ok(!JSON.stringify(pagina).includes('TEXTO AJENO'));
});

test('una plantilla sin sección de página no da márgenes, y no revienta', () => {
  assert.equal(extraerPagina(docxConPagina('')), null);
  assert.equal(extraerPagina(Buffer.from('no es un zip')), null);
  assert.equal(
    extraerPagina(docxConPagina('<w:sectPr><w:pgMar w:top="99999999" w:left="x"/></w:sectPr>')),
    null,
    'medidas absurdas o incompletas se ignoran',
  );
});

test('el Word sale con los márgenes y el tamaño de la plantilla', async () => {
  const { armar } = require('../src/modules/projects/project.docx');
  const buffer = await armar({
    tema: 'Prueba',
    estilos: ESTILOS_XML,
    pagina: extraerPagina(docxConPagina(SECCION_A4)),
    capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }],
  });

  const doc = new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
  assert.match(doc, /<w:pgMar[^>]*w:left="2268"/);
  assert.match(doc, /<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/);
});

// ── El Word que sale ───────────────────────────────────────────────────────

async function armarDePrueba({ conPlantilla }) {
  const { armar } = require('../src/modules/projects/project.docx');
  const buffer = await armar({
    tema: 'Prueba',
    ...(conPlantilla ? { estilos: ESTILOS_XML } : {}),
    capitulos: [
      {
        titulo: '2 · Capítulo I · Problema y objetivos',
        texto: '# Realidad\n\nUn párrafo del cuerpo.\n\n### Problema general\n\n- Objetivo uno',
      },
    ],
    referencias: ['García, J. (2024). Un título largo. Revista, 1(2), 3-4. https://doi.org/10.1/x'],
  });
  const zip = new AdmZip(buffer);
  return {
    doc: zip.getEntry('word/document.xml').getData().toString('utf8'),
    styles: zip.getEntry('word/styles.xml').getData().toString('utf8'),
  };
}

/** El párrafo que contiene ese texto, entero. */
const parrafoCon = (doc, texto) =>
  [...doc.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => m[0]).find((p) => p.includes(texto));

test('con plantilla, el interlineado y la sangría del texto los decide ella', async () => {
  const { doc } = await armarDePrueba({ conPlantilla: true });
  const cuerpo = parrafoCon(doc, 'Un párrafo del cuerpo.');

  assert.doesNotMatch(cuerpo, /w:line="480"/, 'sin doble espacio a mano');
  assert.doesNotMatch(cuerpo, /w:firstLine=/, 'sin sangría a mano');
  assert.doesNotMatch(cuerpo, /<w:jc /, 'sin alineación a mano');
});

test('sin plantilla, el texto sigue a doble espacio, justificado y con sangría', async () => {
  const { doc } = await armarDePrueba({ conPlantilla: false });
  const cuerpo = parrafoCon(doc, 'Un párrafo del cuerpo.');

  assert.match(cuerpo, /w:line="480"/);
  assert.match(cuerpo, /w:firstLine=/);
  assert.match(cuerpo, /<w:jc w:val="both"\/>/);
});

test('las referencias van a la izquierda con sangría francesa, con o sin plantilla', async () => {
  for (const conPlantilla of [true, false]) {
    const { doc } = await armarDePrueba({ conPlantilla });
    const referencia = parrafoCon(doc, 'García, J. (2024)');

    assert.match(referencia, /<w:jc w:val="(left|start)"\/>/, `a la izquierda (plantilla: ${conPlantilla})`);
    assert.match(referencia, /w:hanging=/);
  }
});

test('el título «Índice» no entra en el índice', async () => {
  for (const conPlantilla of [true, false]) {
    const { doc, styles } = await armarDePrueba({ conPlantilla });
    const indice = parrafoCon(doc, '>Índice<');

    assert.match(indice, /<w:pStyle w:val="TOCHeading"\/>/);
    assert.match(styles, /w:styleId="TOCHeading"[\s\S]*?<w:outlineLvl w:val="9"\/>/);
  }
});

test('el título del capítulo sale sin el número del método', async () => {
  const { tituloDelCapitulo } = require('../src/modules/projects/project.docx');
  // El punto medio es como nombramos las fases en el panel; en el documento,
  // dos puntos, que es como titula un capítulo cualquier reglamento.
  assert.equal(tituloDelCapitulo('2 · Capítulo I · Problema y objetivos'), 'Capítulo I: Problema y objetivos');
  assert.equal(tituloDelCapitulo('Fase 3B — Mapeo bibliométrico'), 'Mapeo bibliométrico');
  assert.equal(tituloDelCapitulo('Humanizador académico'), 'Humanizador académico');

  const { doc } = await armarDePrueba({ conPlantilla: true });
  assert.ok(doc.includes('Capítulo I: Problema y objetivos'));
  assert.ok(!doc.includes('2 · Capítulo I'));
});

test('sin plantilla, el cuarto nivel de título sale en negro como los demás', async () => {
  const { styles } = await armarDePrueba({ conPlantilla: false });
  const titulo4 = styles.match(/<w:style [^>]*w:styleId="Heading4"[\s\S]*?<\/w:style>/)?.[0] ?? '';

  assert.match(titulo4, /Times New Roman/);
  assert.match(titulo4, /w:val="000000"/);
});

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
