'use strict';

/**
 * Los títulos de la plantilla y los ajustes del formato dichos en el chat.
 *
 * El caso que lo pidió (1 de octubre de 2026): una plantilla de la UNT hecha en
 * Word en español, con el Título 1 guardado como «Ttulo1» —nuestro Word escribe
 * en «Heading1» y salía el azul de la librería— y otra con su Título 1 en
 * Arial azul de 16 puntos y los títulos puestos a mano en Times negro de 12.
 * Lo que se ve en la plantilla es lo que tiene que salir en la tesis.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const plantilla = require('../src/modules/projects/project.plantilla');
const ajustes = require('../src/modules/projects/project.plantilla-ajustes');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const estilo = (id, nombre, interior = '') =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${nombre}"/>${interior}</w:style>`;

const hoja = (...estilos) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  `${estilos.join('')}</w:styles>`;

/** Un .docx con esa hoja y esos párrafos. */
function docx(estilos, parrafos = []) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<w:document ${W}><w:body>${parrafos.join('')}<w:sectPr/></w:body></w:document>`),
  );
  zip.addFile('word/styles.xml', Buffer.from(estilos));
  return zip.toBuffer();
}

/** Un título con formato a mano. */
const titulo = (id, texto, rPr, jc = '') =>
  `<w:p><w:pPr><w:pStyle w:val="${id}"/>${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>` +
  `<w:r><w:rPr>${rPr}</w:rPr><w:t>${texto}</w:t></w:r></w:p>`;

const TIMES_NEGRO_12 = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:color w:val="000000"/><w:sz w:val="24"/>';
const AZUL_DE_FABRICA = '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496" w:themeColor="accent1"/><w:sz w:val="32"/></w:rPr>';

// ── Los identificadores en español ─────────────────────────────────────────

test('el «Ttulo1» de Word en español pasa a ser el Heading1 que usa nuestro Word', () => {
  const { xml, renombrados } = plantilla.conIdsDeTitulos(
    hoja(
      estilo('Normal', 'Normal'),
      estilo('Ttulo1', 'heading 1', '<w:basedOn w:val="Normal"/><w:link w:val="Ttulo1Car"/>'),
      estilo('Ttulo2', 'heading 2', '<w:basedOn w:val="Ttulo1"/>'),
      '<w:style w:type="character" w:styleId="Ttulo1Car"><w:name w:val="Título 1 Car"/><w:link w:val="Ttulo1"/></w:style>',
    ),
  );

  assert.deepEqual([...renombrados], [['Ttulo1', 'Heading1'], ['Ttulo2', 'Heading2']]);
  assert.match(xml, /w:styleId="Heading1"/);
  assert.doesNotMatch(xml, /w:styleId="Ttulo1"/);
  assert.match(xml, /<w:basedOn w:val="Heading1"\/>/, 'lo que se basaba en él lo sigue haciendo');
  assert.match(xml, /w:styleId="Ttulo1Car"[\s\S]*?<w:link w:val="Heading1"\/>/, 'y su estilo de carácter lo encuentra');
});

test('si ya trae Heading1 no se renombra nada', () => {
  const { renombrados } = plantilla.conIdsDeTitulos(hoja(estilo('Heading1', 'heading 1')));
  assert.equal(renombrados.size, 0);
});

test('el Word armado con una plantilla en español lleva SUS títulos', async () => {
  const { armar } = require('../src/modules/projects/project.docx');
  const buffer = docx(
    hoja(
      estilo('Normal', 'Normal'),
      estilo('Ttulo1', 'heading 1', '<w:rPr><w:rFonts w:ascii="Georgia"/><w:color w:val="800000"/></w:rPr>'),
    ),
  );
  const { xml } = plantilla.estilosParaGuardar(buffer);
  const salida = await armar({ tema: 'Prueba', estilos: xml, capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }] });

  const styles = new AdmZip(salida).getEntry('word/styles.xml').getData().toString('utf8');
  const titulos1 = [...styles.matchAll(/<w:style\s[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/g)];
  assert.equal(titulos1.length, 1);
  assert.match(titulos1[0][0], /Georgia/, 'el de su facultad, no el azul de la librería');
});

// ── Los títulos como se ven ────────────────────────────────────────────────

test('el título del estilo azul y puesto a mano en Times negro sale en Times negro', () => {
  const buffer = docx(
    hoja(
      estilo('Normal', 'Normal'),
      estilo('Heading1', 'heading 1', '<w:rPr><w:rFonts w:ascii="Arial"/><w:color w:val="0070C0"/><w:sz w:val="40"/></w:rPr>'),
    ),
    [
      titulo('Heading1', 'CAPÍTULO I', TIMES_NEGRO_12, 'center'),
      titulo('Heading1', 'CAPÍTULO II', TIMES_NEGRO_12, 'center'),
    ],
  );
  const { xml, cambios } = plantilla.estilosParaGuardar(buffer);
  const t1 = plantilla.interiorDeEstilo(xml, 'Heading1');

  assert.match(t1, /<w:color w:val="000000"\/>/);
  assert.doesNotMatch(t1, /0070C0/);
  assert.match(t1, /<w:sz w:val="24"\/>/);
  assert.match(t1, /w:ascii="Times New Roman"/);
  assert.match(t1, /<w:b\/>/);
  assert.match(t1, /<w:jc w:val="center"\/>/);
  assert.ok(cambios.some((c) => /nivel 1 tomaron el formato que se ve/.test(c)));
});

test('un título de fábrica que la plantilla no usa sale como APA, en negro y con la letra del texto', () => {
  const buffer = docx(
    hoja(
      estilo('Normal', 'Normal', '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr>'),
      estilo('Heading1', 'heading 1', AZUL_DE_FABRICA),
      estilo('Heading2', 'heading 2', AZUL_DE_FABRICA),
      estilo('Heading3', 'heading 3', AZUL_DE_FABRICA),
      estilo('Heading4', 'heading 4', AZUL_DE_FABRICA),
    ),
  );
  const { xml, cambios } = plantilla.estilosParaGuardar(buffer);

  for (const n of [1, 2, 3]) {
    const t = plantilla.interiorDeEstilo(xml, `Heading${n}`);
    assert.match(t, /<w:color w:val="000000"\/>/, `nivel ${n} en negro`);
    assert.doesNotMatch(t, /themeColor|majorHAnsi/, `nivel ${n} sin el azul ni la letra de títulos`);
    assert.match(t, /Times New Roman/);
    assert.match(t, /<w:sz w:val="24"\/>/);
  }
  assert.match(plantilla.interiorDeEstilo(xml, 'Heading1'), /<w:jc w:val="center"\/>/);
  assert.match(plantilla.interiorDeEstilo(xml, 'Heading3'), /<w:i\/>/);
  assert.ok(cambios.some((c) => /formato de fábrica/.test(c)));
});

test('un título que la facultad definió y no usa en la página se queda como está', () => {
  const suyo = '<w:rPr><w:rFonts w:ascii="Georgia"/><w:color w:val="800000"/></w:rPr>';
  const { xml } = plantilla.estilosParaGuardar(docx(hoja(estilo('Normal', 'Normal'), estilo('Heading1', 'heading 1', suyo))));
  assert.match(plantilla.interiorDeEstilo(xml, 'Heading1'), /800000/);
});

test('el nivel que la plantilla no trae se crea en APA, para que no salga el azul de la librería', () => {
  const { xml, cambios } = plantilla.estilosParaGuardar(docx(hoja(estilo('Normal', 'Normal'), estilo('Heading1', 'heading 1'))));
  for (const n of [2, 3, 4]) assert.match(xml, new RegExp(`w:styleId="Heading${n}"`));
  assert.match(plantilla.interiorDeEstilo(xml, 'Heading2'), /<w:color w:val="000000"\/>/);
  assert.ok(cambios.some((c) => /no venían en la plantilla/.test(c)));
});

test('la letra del cuerpo puesta a mano pasa al estilo del cuerpo', () => {
  const largo = 'Texto del cuerpo de la tesis que se repite para pasar del largo mínimo. '.repeat(4);
  const parrafo =
    '<w:p><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr>' +
    `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t>${largo}</w:t></w:r></w:p>`;
  const buffer = docx(hoja(estilo('Normal', 'Normal'), estilo('Heading1', 'heading 1')), Array(6).fill(parrafo));
  const { xml } = plantilla.estilosParaGuardar(buffer);
  assert.match(plantilla.interiorDeEstilo(xml, 'CuerpoTesis'), /w:ascii="Times New Roman"/);
});

// ── Los ajustes del chat ───────────────────────────────────────────────────

test('sin plantilla, los ajustes van sobre nuestro formato y el texto sale con ellos', async () => {
  const docxMod = require('../src/modules/projects/project.docx');
  const base = await docxMod.hojaDeEstilosPorDefecto();
  const r = ajustes.aplicar(base, null, {
    fuente: 'Arial',
    tamano: 11,
    interlineado: 1.5,
    sangria: 1.27,
    espacioEntreParrafos: 0,
    margenes: { izquierdo: 3.5 },
    papel: 'A4',
  });

  const cuerpo = plantilla.interiorDeEstilo(r.estilos, 'CuerpoTesis');
  assert.match(cuerpo, /w:line="360"/);
  assert.match(cuerpo, /w:after="0"/);
  assert.match(cuerpo, /w:firstLine="720"/);
  assert.match(cuerpo, /<w:sz w:val="22"\/>/);
  assert.match(cuerpo, /w:ascii="Arial"/);
  assert.match(plantilla.interiorDeEstilo(r.estilos, 'Heading1'), /w:ascii="Arial"/, 'los títulos con la misma letra');
  assert.equal(r.pagina.margen.left, 1984);
  assert.equal(r.pagina.margen.top, 1701, 'los lados que no se pidieron, los de siempre');
  assert.deepEqual(r.pagina.tamano, { width: 11906, height: 16838 });

  const salida = await docxMod.armar({
    tema: 'Prueba',
    estilos: r.estilos,
    pagina: r.pagina,
    capitulos: [{ titulo: 'Capítulo I', texto: 'Un párrafo del cuerpo.' }],
  });
  const doc = new AdmZip(salida).getEntry('word/document.xml').getData().toString('utf8');
  const parrafo = [...doc.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => m[0]).find((p) => p.includes('Un párrafo del cuerpo.'));
  assert.match(parrafo, /<w:pStyle w:val="CuerpoTesis"\/>/);
  assert.match(doc, /<w:pgMar[^>]*w:left="1984"/);
});

test('la hoja por defecto deja el texto como sin plantilla: doble, justificado y con sangría', async () => {
  const base = await require('../src/modules/projects/project.docx').hojaDeEstilosPorDefecto();
  const cuerpo = plantilla.interiorDeEstilo(base, 'CuerpoTesis');
  assert.match(cuerpo, /w:line="480"/);
  assert.match(cuerpo, /<w:jc w:val="both"\/>/);
  assert.match(cuerpo, /w:firstLine="720"/);
});

test('títulos APA 7 por el chat, sobre una plantilla con títulos azules', () => {
  const base = hoja(
    estilo('Normal', 'Normal', '<w:rPr><w:sz w:val="24"/></w:rPr>'),
    estilo('Heading1', 'heading 1', '<w:pPr><w:ind w:left="1134"/></w:pPr><w:rPr><w:color w:val="0070C0"/><w:sz w:val="40"/><w:caps/></w:rPr>'),
  );
  const r = ajustes.aplicar(base, null, { titulosApa7: true, titulos: [{ nivel: 2, mayusculas: true }] });

  const t1 = plantilla.interiorDeEstilo(r.estilos, 'Heading1');
  assert.match(t1, /<w:color w:val="000000"\/>/);
  assert.match(t1, /<w:sz w:val="24"\/>/);
  assert.match(t1, /<w:jc w:val="center"\/>/);
  assert.match(t1, /<w:caps w:val="0"\/>/);
  assert.match(t1, /<w:ind w:left="0" w:firstLine="0"\/>/, 'sin la sangría que lo descentraba');
  assert.match(plantilla.interiorDeEstilo(r.estilos, 'Heading3'), /<w:i\/>/, 'el nivel que faltaba se crea');
  assert.match(plantilla.interiorDeEstilo(r.estilos, 'Heading2'), /<w:caps\/>/, 'y el ajuste de un nivel va después');
  assert.equal(r.pagina, null, 'la página no se toca si no se pidió');
});

test('un ajuste absurdo no cambia nada y dice qué corregir', () => {
  assert.throws(() => ajustes.aplicar(hoja(), null, { tamano: 40 }), ajustes.AjusteNoValido);
  assert.throws(() => ajustes.aplicar(hoja(), null, { fuente: 'Arial"/><w:b/>' }), /nombre de la letra/);
  assert.throws(() => ajustes.aplicar(hoja(), null, {}), /ningún ajuste/);
  assert.throws(() => ajustes.aplicar(hoja(), null, { titulos: [{ nivel: 7 }] }), /del 1 al 4/);
});

test('el XML de la hoja sigue en el orden que exige Word tras los ajustes', () => {
  const r = ajustes.aplicar(hoja(estilo('Normal', 'Normal'), estilo('Heading1', 'heading 1')), null, {
    fuente: 'Arial',
    titulosApa7: true,
  });
  const t1 = plantilla.interiorDeEstilo(r.estilos, 'Heading1');
  assert.ok(t1.indexOf('<w:pPr>') < t1.indexOf('<w:rPr>'), 'pPr antes que rPr');
  const rPr = t1.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)[1];
  assert.ok(rPr.indexOf('<w:rFonts') < rPr.indexOf('<w:b/>'));
  assert.ok(rPr.indexOf('<w:color') < rPr.indexOf('<w:sz '));
});
