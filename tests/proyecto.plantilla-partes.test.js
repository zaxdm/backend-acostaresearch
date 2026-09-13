'use strict';

/**
 * Numeración, encabezado, pie y portada de la plantilla.
 *
 * Lo que se prueba: que salen de la plantilla con sus imágenes, que de la
 * portada solo se guarda la primera página y solo con marcas, que lo que hay
 * detrás no se guarda, y que el Word que sale los lleva bien enlazados —cada
 * relación apunta a un archivo que existe—, que es lo que decide si Word lo
 * abre o dice que está dañado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const partesDePlantilla = require('../src/modules/projects/project.plantilla-partes');
const { armar } = require('../src/modules/projects/project.docx');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = `${R}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ESTILOS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">` +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
  '<w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';

const imagen = (id) =>
  '<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill>' +
  `<a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const PORTADA_CON_MARCAS =
  `<w:p>${imagen('rId9')}</w:p>` +
  // Partida en dos corridas, como la deja Word.
  '<w:p><w:r><w:t>{{TIT</w:t></w:r><w:r><w:t>ULO}}</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t xml:space="preserve">Autor: {{AUTOR}} · Asesor: {{ASESOR}}</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Lima, {{AÑO}}</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>';

function plantillaDePrueba({
  portada = PORTADA_CON_MARCAS,
  relPortada = `<Relationship Id="rId9" Type="${REL}/image" Target="media/image1.png"/>`,
} = {}) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="urn:wp" xmlns:a="urn:a" xmlns:pic="urn:pic" ` +
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w99="urn:prueba" ' +
        'mc:Ignorable="w99"><w:body>' +
        portada +
        '<w:p><w:r><w:t>TEXTO AJENO DE OTRA TESIS</w:t></w:r></w:p>' +
        '<w:sectPr><w:headerReference w:type="default" r:id="rId10"/>' +
        '<w:footerReference w:type="default" r:id="rId11"/>' +
        '<w:headerReference w:type="first" r:id="rId12"/>' +
        '<w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="2268"/><w:titlePg/></w:sectPr>' +
        '</w:body></w:document>',
    ),
  );
  zip.addFile(
    'word/_rels/document.xml.rels',
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        relPortada +
        `<Relationship Id="rId10" Type="${REL}/header" Target="header1.xml"/>` +
        `<Relationship Id="rId11" Type="${REL}/footer" Target="footer1.xml"/>` +
        `<Relationship Id="rId12" Type="${REL}/header" Target="header2.xml"/>` +
        '</Relationships>',
    ),
  );
  zip.addFile(
    'word/header1.xml',
    Buffer.from(
      `<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:r><w:t>UNIVERSIDAD X · FACULTAD Y</w:t></w:r></w:p>` +
        `<w:p>${imagen('rId1')}</w:p></w:hdr>`,
    ),
  );
  zip.addFile(
    'word/_rels/header1.xml.rels',
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL}/image" Target="media/image1.png"/></Relationships>`,
    ),
  );
  zip.addFile(
    'word/footer1.xml',
    Buffer.from(`<w:ftr xmlns:w="${W}"><w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`),
  );
  zip.addFile('word/header2.xml', Buffer.from(`<w:hdr xmlns:w="${W}"><w:p/></w:hdr>`));
  zip.addFile(
    'word/numbering.xml',
    Buffer.from(
      `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0">` +
        '<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
        '<w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>',
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(ESTILOS));
  zip.addFile('word/media/image1.png', PNG);
  return zip.toBuffer();
}

// ── Lo que se saca ─────────────────────────────────────────────────────────

test('de la plantilla salen numeración, encabezados, pie y portada con su imagen', () => {
  const partes = partesDePlantilla.extraer(plantillaDePrueba());

  assert.match(partes.numeracion, /w:abstractNumId="7"/);
  assert.match(partes.encabezados.default.xml, /UNIVERSIDAD X/);
  assert.ok(partes.encabezados.first, 'el de la primera página también');
  assert.match(partes.pies.default.xml, /PAGE/);
  assert.equal(partes.primeraPaginaDistinta, true);

  assert.match(partes.portada.xml, /\{\{TIT/);
  assert.match(partes.portada.rels[0].target, /^media\/pl-[0-9a-f]{16}\.png$/);
  assert.equal(Object.keys(partes.medios).length, 1, 'la misma imagen se guarda una vez');

  assert.deepEqual(partesDePlantilla.resumen(partes), {
    numeracion: true,
    encabezado: true,
    pie: true,
    portada: true,
    portadaSinMarcas: false,
  });
});

test('lo que hay detrás de la portada NO se guarda', () => {
  const partes = partesDePlantilla.extraer(plantillaDePrueba());
  assert.ok(!JSON.stringify(partes).includes('TEXTO AJENO'));
});

test('una portada sin marcas no se guarda, y se dice por qué', () => {
  const partes = partesDePlantilla.extraer(
    plantillaDePrueba({
      portada: '<w:p><w:r><w:t>Juan Pérez, Tesis 2019</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>',
    }),
  );
  assert.equal(partes.portada, null);
  assert.equal(partes.portadaSinMarcas, true);
  assert.ok(!JSON.stringify(partes).includes('Juan Pérez'));
});

test('sin salto de página no hay portada: no se sabe dónde acaba', () => {
  const partes = partesDePlantilla.extraer(
    plantillaDePrueba({ portada: '<w:p><w:r><w:t>{{TITULO}}</w:t></w:r></w:p>' }),
  );
  assert.equal(partes.portada, null);
});

test('una portada con algo que no es una imagen (un objeto incrustado) no se lleva a medias', () => {
  const partes = partesDePlantilla.extraer(
    plantillaDePrueba({
      relPortada: `<Relationship Id="rId9" Type="${REL}/oleObject" Target="embeddings/x.bin"/>`,
    }),
  );
  assert.equal(partes.portada, null);
});

test('un archivo que no es un zip no revienta', () => {
  assert.deepEqual(partesDePlantilla.resumen(partesDePlantilla.extraer(Buffer.from('nada'))), {
    numeracion: false,
    encabezado: false,
    pie: false,
    portada: false,
    portadaSinMarcas: false,
  });
});

// ── El Word que sale ───────────────────────────────────────────────────────

async function wordConPartes() {
  const partes = partesDePlantilla.extraer(plantillaDePrueba());
  const buffer = await armar({
    tema: 'Mi tema de tesis',
    nombre: 'Ana Pérez & Co',
    universidad: 'UNFV',
    estilos: ESTILOS,
    partes,
    capitulos: [{ titulo: 'Capítulo I', texto: '# Realidad\n\nTexto.' }],
    referencias: ['García, J. (2024). Título. Revista, 1(2), 3-4.'],
  });
  const zip = new AdmZip(buffer);
  const leer = (n) => zip.getEntry(n)?.getData().toString('utf8');
  return { zip, leer, doc: leer('word/document.xml'), rels: leer('word/_rels/document.xml.rels') };
}

const relacion = (rels, id) =>
  rels.match(new RegExp(`<Relationship [^>]*Id="${id}"[^>]*/>`))?.[0] ?? '';
const destino = (rel) => rel.match(/Target="([^"]+)"/)?.[1];

test('la portada sale con los datos del proyecto y las marcas desconocidas a la vista', async () => {
  const { doc } = await wordConPartes();

  assert.ok(doc.includes('Mi tema de tesis'));
  assert.ok(doc.includes('Autor: Ana Pérez &amp; Co'), 'con el & escapado');
  assert.ok(doc.includes('{{ASESOR}}'), 'la que no conocemos se deja para completarla');
  assert.ok(doc.includes(`Lima, ${new Date().getFullYear()}`));
  assert.ok(!doc.includes('{{TIT'));
  assert.ok(!doc.includes(partesDePlantilla.MARCA_PORTADA));
  assert.ok(!doc.includes('>UNFV<'), 'nuestra portada no sale además de la suya');
});

test('la imagen de la portada apunta a un archivo que existe', async () => {
  const { zip, doc, rels } = await wordConPartes();
  const id = doc.match(/<a:blip r:embed="([^"]+)"\/>/)[1];
  const target = destino(relacion(rels, id));

  assert.match(target, /^media\/pl-/);
  assert.ok(zip.getEntry(`word/${target}`), 'la imagen está dentro del Word');
});

test('los espacios de nombres de la portada se declaran en el documento', async () => {
  const { doc } = await wordConPartes();
  const raiz = doc.match(/<w:document\b[^>]*>/)[0];

  assert.match(raiz, /xmlns:w99="urn:prueba"/);
  assert.match(raiz, /mc:Ignorable="[^"]*\bw99\b[^"]*"/);
});

test('encabezados y pie de la plantilla, enlazados, y ya no el pie nuestro', async () => {
  const { zip, leer, doc, rels } = await wordConPartes();
  const seccion = doc.slice(doc.lastIndexOf('<w:sectPr'));
  const refs = [...seccion.matchAll(/<w:(header|footer)Reference w:type="(\w+)" r:id="([^"]+)"\/>/g)];

  assert.deepEqual(
    refs.map(([, clase, tipo]) => `${clase}:${tipo}`).sort(),
    ['footer:default', 'header:default', 'header:first'],
  );
  for (const [, , , id] of refs) {
    const target = destino(relacion(rels, id));
    assert.match(target, /Pl\d+\.xml$/, 'apunta a la parte copiada, no a la nuestra');
    assert.ok(zip.getEntry(`word/${target}`), `${target} existe`);
    assert.match(leer('[Content_Types].xml'), new RegExp(`PartName="/word/${target}"`));
  }

  assert.match(seccion, /<w:titlePg\/>/);
  const encabezado = destino(relacion(rels, refs.find(([, c, t]) => c === 'header' && t === 'default')[3]));
  const relsDelEncabezado = leer(`word/_rels/${encabezado}.rels`);
  assert.ok(zip.getEntry(`word/${destino(relsDelEncabezado.match(/<Relationship [^>]*\/>/)[0])}`));
});

test('la numeración de los títulos es la de la plantilla', async () => {
  const { leer } = await wordConPartes();
  assert.match(leer('word/numbering.xml'), /w:abstractNumId="7"/);
});

test('con títulos numerados, ni el Índice ni las Referencias llevan número', async () => {
  const { doc, leer } = await wordConPartes();

  // El Índice: su estilo anula la numeración que heredaría de Título 1.
  const indice = leer('word/styles.xml').match(/<w:style [^>]*w:styleId="TOCHeading"[\s\S]*?<\/w:style>/)[0];
  assert.match(indice, /<w:numId w:val="0"\/>/);

  // Las Referencias: el párrafo la anula, y en su sitio, antes del espaciado.
  const referencias = [...doc.matchAll(/<w:p\b[^>]*>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g)]
    .map((m) => m[0])
    .find((p) => p.includes('>Referencias</w:t>'));
  assert.match(referencias, /<w:pPr><w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/><w:numPr><w:ilvl w:val="0"\/><w:numId w:val="0"\/><\/w:numPr>/);

  // Y el capítulo sí sigue con la numeración de su estilo: no se toca.
  const capitulo = [...doc.matchAll(/<w:p\b[^>]*>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g)]
    .map((m) => m[0])
    .find((p) => p.includes('>Capítulo I</w:t>'));
  assert.doesNotMatch(capitulo, /<w:numPr>/);
});

test('si la numeración de la plantilla ya dice «Capítulo», el título no lo repite', () => {
  const { tituloDelCapitulo } = require('../src/modules/projects/project.docx');

  assert.equal(
    tituloDelCapitulo('2 · Capítulo I · Problema y objetivos', { sinCapitulo: true }),
    'Problema y objetivos',
  );
  assert.equal(
    tituloDelCapitulo('2 · Capítulo I · Problema y objetivos'),
    'Capítulo I · Problema y objetivos',
    'sin esa numeración, se queda',
  );
  assert.equal(tituloDelCapitulo('Humanizador académico', { sinCapitulo: true }), 'Humanizador académico');
});

test('sin partes, el Word sale como siempre, con nuestra portada', async () => {
  const buffer = await armar({
    tema: 'Otro tema',
    universidad: 'UNFV',
    capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }],
  });
  const doc = new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
  assert.ok(doc.includes('>UNFV<'));
  assert.ok(!doc.includes(partesDePlantilla.MARCA_PORTADA));
});
