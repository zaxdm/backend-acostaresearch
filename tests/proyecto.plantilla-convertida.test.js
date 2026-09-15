'use strict';

/**
 * Una plantilla de facultad convertida desde PDF.
 *
 * El caso real es la de la UPN que subió un tesista el 15 de septiembre de 2026:
 * no se aplicó casi nada. Tenía 69 secciones, una por página, con el encabezado
 * y el pie definidos solo en la segunda; margen izquierdo de medio centímetro y
 * la distancia al borde puesta como sangría en cada párrafo; el doble espacio
 * párrafo a párrafo y no en «Normal»; el título de la portada con el estilo
 * «Title»; dos autores y «Asesor:» en un mismo párrafo con saltos de línea, y el
 * título y los autores de ejemplo repetidos en el encabezado y el pie.
 *
 * Aquí se arma una plantilla con esas mismas trampas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const plantilla = require('../src/modules/projects/project.plantilla');
const partesDePlantilla = require('../src/modules/projects/project.plantilla-partes');
const portadaAuto = require('../src/modules/projects/project.portada-auto');
const { armar } = require('../src/modules/projects/project.docx');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const p = (texto, pPr = '') =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;

const LARGO =
  'Este párrafo es del cuerpo de la tesis de ejemplo y tiene que ser largo para contar como tal, ' +
  'así que sigue un poco más con una frase que no dice nada importante pero ocupa sitio en la página, ' +
  'y todavía un poco más, porque solo cuentan los párrafos de más de doscientos caracteres.';
const CUERPO_PPR =
  '<w:pStyle w:val="BodyText"/><w:spacing w:line="480" w:lineRule="auto"/>' +
  '<w:ind w:left="1419" w:right="373" w:firstLine="707"/>';

const PAGINA_PDF =
  '<w:pgSz w:w="11910" w:h="16850"/>' +
  '<w:pgMar w:top="1560" w:right="1133" w:bottom="1760" w:left="283" w:header="834" w:footer="1576" w:gutter="0"/>';
const seccion = (referencias = '') => `<w:p><w:pPr><w:sectPr>${referencias}${PAGINA_PDF}</w:sectPr></w:pPr></w:p>`;

const PORTADA = [
  p('FACULTAD DE CIENCIAS DE LA SALUD'),
  p('Carrera de PSICOLOGÍA'),
  p(
    '“RESILIENCIA Y PROCRASTINACIÓN ACADÉMICA EN ESTUDIANTES DE PSICOLOGÍA DE UNA UNIVERSIDAD PRIVADA DE LIMA METROPOLITANA”',
    '<w:pStyle w:val="Title"/>',
  ),
  p('Tesis para optar al título profesional de:'),
  p('Licenciada en psicología'),
  p('Autores:'),
  '<w:p><w:r><w:t>Angie Stefani Paico Gordillo de Acosta</w:t><w:br/><w:t>Sindy Karina Sanchez Sobrado</w:t>' +
    '<w:br/><w:t>Asesor:</w:t></w:r></w:p>',
  p('Mg. Claudia Karina Guevara Cordero'),
  p('https//orcid.org/0000-0003-4681-3077'),
  p('Lima - Perú'),
  p('2025'),
].join('');

const ESTILOS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">` +
  '<w:style w:default="1" w:styleId="Normal" w:type="paragraph"><w:name w:val="Normal"/><w:qFormat/><w:pPr/>' +
  '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr></w:style>' +
  '<w:style w:styleId="BodyText" w:type="paragraph"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr/><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:styleId="Heading1" w:type="paragraph"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="1134"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>' +
  '<w:style w:styleId="Title" w:type="paragraph"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="1443" w:right="310"/><w:jc w:val="center"/></w:pPr></w:style>' +
  '</w:styles>';

const ENCABEZADO =
  `<w:hdr xmlns:w="${W}">` +
  // El texto de ejemplo, dos veces: como en el cuadro de texto y su copia antigua.
  '<w:p><w:r><w:t xml:space="preserve">Resiliencia y procrastinación académica en estudiantes de</w:t></w:r>' +
  '<w:r><w:t>psicología de una universidad privada de Lima Metropolitana 2025</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t xml:space="preserve">Resiliencia y procrastinación académica en estudiantes de</w:t></w:r>' +
  '<w:r><w:t>psicología de una universidad privada de Lima Metropolitana 2025</w:t></w:r></w:p>' +
  '</w:hdr>';

const PIE =
  `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Pág.</w:t></w:r></w:p>` +
  '<w:p><w:r><w:t>Paico,</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>A.;</w:t></w:r>' +
  '<w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>Sánchez,</w:t></w:r>' +
  '<w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>S.</w:t></w:r></w:p></w:ftr>';

function plantillaConvertida() {
  const cuerpo = (n) => Array.from({ length: n }, () => p(LARGO, CUERPO_PPR)).join('');
  const documento =
    `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>` +
    PORTADA +
    seccion() +
    // La sección 2 define encabezado y pie; la 3, con más texto, los hereda.
    cuerpo(6) +
    seccion('<w:headerReference w:type="default" r:id="rId10"/><w:footerReference w:type="default" r:id="rId11"/>') +
    cuerpo(8) +
    seccion() +
    // La última: una hoja de anexos casi vacía, con otro margen inferior.
    p('Anexo') +
    '<w:sectPr><w:pgSz w:w="11910" w:h="16850"/><w:pgMar w:top="1560" w:right="1417" w:bottom="280" w:left="1417"/></w:sectPr>' +
    '</w:body></w:document>';

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from(documento));
  zip.addFile('word/styles.xml', Buffer.from(ESTILOS));
  zip.addFile('word/header1.xml', Buffer.from(ENCABEZADO));
  zip.addFile('word/footer1.xml', Buffer.from(PIE));
  zip.addFile(
    'word/_rels/document.xml.rels',
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId10" Type="${R}/header" Target="header1.xml"/>` +
        `<Relationship Id="rId11" Type="${R}/footer" Target="footer1.xml"/>` +
        '</Relationships>',
    ),
  );
  return zip.toBuffer();
}

const sinGemini = async () => {
  throw new Error('sin Gemini en la prueba');
};

const estiloDe = (xml, id) => (xml.match(new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`)) || [''])[0];

async function partesListas() {
  return portadaAuto.prepararPortada(partesDePlantilla.extraer(plantillaConvertida()), { clasificar: sinGemini });
}

test('los márgenes son los de la sección del cuerpo, con la sangría del PDF devuelta al margen', () => {
  const { margen, tamano } = plantilla.extraerPagina(plantillaConvertida());
  assert.equal(margen.left, 283 + 1419, 'medio centímetro de margen más la sangría de cada párrafo');
  assert.equal(margen.right, 1133 + 373);
  assert.equal(margen.bottom, 1760, 'no el de la hoja de anexos del final');
  assert.equal(margen.top, 1560);
  assert.deepEqual(tamano, { width: 11910, height: 16850 });
});

test('«Cuerpo de tesis» toma el doble espacio, la sangría y la letra; «Normal» no se toca', () => {
  const buffer = plantillaConvertida();
  const estilos = plantilla.conFormatoDelCuerpo(plantilla.extraerEstilos(buffer), buffer);

  const cuerpo = estiloDe(estilos, 'CuerpoTesis');
  assert.match(cuerpo, /<w:basedOn w:val="Normal"\/>/);
  assert.match(cuerpo, /<w:spacing w:line="480" w:lineRule="auto"\/>/);
  assert.match(cuerpo, /<w:ind w:firstLine="707"\/>/, 'la sangría izquierda ya está en el margen');
  assert.match(cuerpo, /<w:sz w:val="24"\/><w:szCs w:val="24"\/>/);
  // pPr antes que rPr: el orden que exige el esquema.
  assert.ok(cuerpo.indexOf('<w:pPr>') < cuerpo.indexOf('<w:rPr>'));

  // La portada, el encabezado y el pie heredan de «Normal»: con doble espacio
  // la portada se salía de su hoja y el número de página quedaba cortado.
  const normal = estiloDe(estilos, 'Normal');
  assert.doesNotMatch(normal, /w:line="480"/);
  assert.match(normal, /<w:rFonts w:ascii="Times New Roman"/);

  assert.match(estiloDe(estilos, 'Heading1'), /w:left="0"/, 'sin la sangría que era del PDF');
  assert.match(estiloDe(estilos, 'Title'), /w:left="24"/);

  // Volver a aplicarlo no duplica el estilo.
  const otraVez = plantilla.conFormatoDelCuerpo(estilos, buffer);
  assert.equal(otraVez.match(/w:styleId="CuerpoTesis"/g).length, 1);
});

test('una plantilla hecha en Word, con márgenes normales, no pierde la sangría de sus párrafos', () => {
  const buffer = plantillaConvertida();
  const zip = new AdmZip(buffer);
  const documento = zip.getEntry('word/document.xml').getData().toString('utf8').replace(/w:left="283"/g, 'w:left="1701"');
  zip.updateFile('word/document.xml', Buffer.from(documento));
  const normal = new AdmZip(zip.toBuffer());
  const { margen } = plantilla.extraerPagina(normal.toBuffer());
  assert.equal(margen.left, 1701, 'con margen de 3 cm no hay nada que devolver');
});

test('el encabezado y el pie se toman de la sección que gobierna el cuerpo, aunque la última no tenga', () => {
  const partes = partesDePlantilla.extraer(plantillaConvertida());
  assert.ok(partes.encabezados.default);
  assert.ok(partes.pies.default);
  assert.equal(partes.portadaSinCabecera, true, 'la sección de la portada no define encabezado ni pie');
});

test('la portada llega hasta su salto de sección aunque el título tenga el estilo «Title»', async () => {
  const partes = await partesListas();
  assert.ok(partes.portada, 'la portada se usa');
  assert.deepEqual([...partes.camposDePortada].sort(), ['anio', 'asesor', 'autor', 'carrera', 'titulo']);

  const xml = partes.portada.xml;
  for (const ajeno of ['RESILIENCIA', 'Angie', 'Sindy', 'Claudia', 'orcid', '2025']) {
    assert.ok(!xml.includes(ajeno), `no queda «${ajeno}»`);
  }
  for (const marca of ['{{TITULO}}', '{{AUTOR}}', '{{ASESOR}}', '{{AÑO}}']) assert.ok(xml.includes(marca), marca);
  assert.ok(xml.includes('Asesor:'), 'la etiqueta del mismo párrafo se queda');
});

test('el título y los autores de ejemplo salen del encabezado y el pie; lo fijo se queda', async () => {
  const partes = await partesListas();
  const encabezado = partes.encabezados.default.xml;
  const pie = partes.pies.default.xml;

  assert.ok(!encabezado.includes('Resiliencia'));
  // Dos párrafos seguidos con el título: va entero en el primero y el segundo se vacía.
  assert.equal(encabezado.match(/\{\{TITULO\}\}/g).length, 1);
  assert.ok(!pie.includes('Paico'));
  assert.ok(pie.includes('{{AUTORCORTO}}'));
  assert.ok(pie.includes('Pág.'));
});

test('el Word lleva el encabezado con su tema, el pie con su apellido y la portada con sus datos', async () => {
  const buffer = plantillaConvertida();
  const partes = await partesListas();
  const salida = await armar({
    tema: 'Motivación y rendimiento en estudiantes de enfermería',
    nombre: 'BENICIO GONZALO ACOSTA ENRIQUEZ',
    asesor: 'Dr. Juan Pérez',
    estilos: plantilla.conFormatoDelCuerpo(plantilla.extraerEstilos(buffer), buffer),
    pagina: plantilla.extraerPagina(buffer),
    partes,
    capitulos: [{ titulo: 'Capítulo I', texto: '## Realidad problemática\n\nUn párrafo del tesista.' }],
  });

  const zip = new AdmZip(salida);
  const leer = (patron) =>
    zip
      .getEntries()
      .filter((e) => patron.test(e.entryName))
      .map((e) => e.getData().toString('utf8'))
      .join('');

  assert.ok(leer(/word\/headerPl\d+\.xml$/).includes('Motivación y rendimiento en estudiantes de enfermería'));
  assert.ok(leer(/word\/footerPl\d+\.xml$/).includes('Acosta, B.'));

  const documento = leer(/word\/document\.xml$/);
  assert.ok(documento.includes('BENICIO GONZALO ACOSTA ENRIQUEZ'));
  assert.ok(documento.includes('Dr. Juan Pérez'));
  assert.ok(!documento.includes('Sindy'));
  assert.match(documento, /w:left="1702"/, 'el margen izquierdo de la tesis, no el del PDF');
  assert.match(documento, /<w:titlePg\/>/, 'la portada sin encabezado ni pie, como en la plantilla');
  assert.match(documento, /<w:pStyle w:val="CuerpoTesis"\/>/, 'el texto en el estilo del cuerpo');
  assert.doesNotMatch(documento, /<w:t>/, 'todos los textos copiados conservan sus espacios');
});

test('dos autores y «Asesor:» en el mismo texto, sin salto: se parten y se reconocen', () => {
  const lineas = [
    { linea: 0, texto: 'Autores:', partes: ['Autores:'] },
    {
      linea: 1,
      texto: 'Angie Stefani Paico Gordillo de Acosta Sindy Karina Sanchez Sobrado Asesor:',
      partes: ['Angie Stefani Paico Gordillo de Acosta Sindy Karina Sanchez Sobrado Asesor:'],
    },
    { linea: 2, texto: 'Mg. Claudia Karina Guevara Cordero', partes: ['Mg. Claudia Karina Guevara Cordero'] },
    { linea: 3, texto: 'https//orcid.org/0000-0003-4681-3077', partes: ['https//orcid.org/0000-0003-4681-3077'] },
    { linea: 4, texto: 'Carrera de PSICOLOGÍA', partes: ['Carrera de PSICOLOGÍA'] },
  ];
  const campos = portadaAuto.validar(portadaAuto.clasificarConReglas(lineas), lineas);
  const de = (campo) => campos.filter((c) => c.campo === campo).map((c) => c.texto);

  assert.deepEqual(de('autor'), ['Angie Stefani Paico Gordillo de Acosta Sindy Karina Sanchez Sobrado']);
  assert.deepEqual(de('asesor'), ['Mg. Claudia Karina Guevara Cordero']);
  assert.deepEqual(de('instruccion'), ['https//orcid.org/0000-0003-4681-3077']);
  assert.deepEqual(de('carrera'), ['PSICOLOGÍA']);
});

test('un título partido en dos párrafos del encabezado se reconoce trozo a trozo', () => {
  const titulo = '“RESILIENCIA Y PROCRASTINACIÓN ACADÉMICA EN ESTUDIANTES DE PSICOLOGÍA DE UNA UNIVERSIDAD PRIVADA DE LIMA METROPOLITANA”';
  assert.ok(portadaAuto.parteDelTitulo('Resiliencia y procrastinación académica en estudiantes de', titulo));
  assert.ok(portadaAuto.parteDelTitulo('psicología de una universidad privada de Lima Metropolitana 2025', titulo));
  assert.ok(!portadaAuto.parteDelTitulo('Universidad Privada del Norte · Facultad de Ciencias de la Salud', titulo));
});

test('el apellido para el pie sale del nombre completo', () => {
  assert.equal(partesDePlantilla.autorCorto('BENICIO GONZALO ACOSTA ENRIQUEZ'), 'Acosta, B.');
  assert.equal(partesDePlantilla.autorCorto('Juan Pérez'), 'Pérez, J.');
  assert.equal(partesDePlantilla.autorCorto('María Pérez Gómez'), 'Pérez, M.');
});
