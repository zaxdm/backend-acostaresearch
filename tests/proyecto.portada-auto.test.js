'use strict';

/**
 * La portada de la plantilla, sin que el tesista escriba marcas.
 *
 * El caso de prueba es la carátula real de la UNFV (Facultad de Psicología):
 * un archivo de una hoja, sin salto al final, con el título, el autor y el
 * asesor DE EJEMPLO y con instrucciones entre paréntesis. Lo que se prueba: que
 * se detecta con Gemini y, sin él, con las reglas; que los datos de ejemplo no
 * se guardan; que el dato hereda el formato de su corrida; y que el Word sale
 * con los datos del proyecto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const partesDePlantilla = require('../src/modules/projects/project.plantilla-partes');
const portadaAuto = require('../src/modules/projects/project.portada-auto');
const { armar } = require('../src/modules/projects/project.docx');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const linea = (texto) => `<w:p><w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;
const ROJO = '<w:rPr><w:color w:val="FF0000"/></w:rPr>';

/** La carátula UNFV, tal cual. */
const CARATULA_UNFV = [
  linea('Facultad de Psicología'),
  linea('(aquí debe ir el nombre de su proyecto) SATISFACCIÓN LABORAL Y COMPROMISO ORGANIZACIONAL DE LOS COLABORADORES EN UNA EMPRESA'),
  linea('Líneas de investigación: ……………..'),
  linea('Tesis para optar el título profesional de Licenciada en Psicología'),
  linea('AUTOR'),
  linea('(Aquí debe ir su nombre )'),
  linea('SOLIS  PAREDES GABRIELA LÍZBEL '),
  linea('ASESOR'),
  // Instrucción en rojo y nombre en negro, en la misma línea.
  `<w:p><w:r>${ROJO}<w:t>(El nombre de su Asesor)</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>SANCHEZ GÒMEZ, LUIS</w:t></w:r></w:p>`,
  linea('JURADO'),
  linea('…………………………….'),
  linea('Lima – Perú'),
  linea('20'),
].join('');

function docx(cuerpo) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<w:document xmlns:w="${W}"><w:body>${cuerpo}<w:sectPr><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701"/></w:sectPr></w:body></w:document>`,
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<w:styles xmlns:w="${W}"></w:styles>`));
  return zip.toBuffer();
}

const sinGemini = async () => {
  throw new Error('sin Gemini en la prueba');
};

// ── Sin Gemini: las reglas ─────────────────────────────────────────────────

test('las reglas encuentran título, autor, asesor, carrera y año en la carátula UNFV', async () => {
  const partes = await portadaAuto.prepararPortada(partesDePlantilla.extraer(docx(CARATULA_UNFV)), {
    clasificar: sinGemini,
  });

  assert.deepEqual(partes.camposDePortada, ['titulo', 'autor', 'asesor', 'carrera', 'anio']);
  const xml = partes.portada.xml;
  assert.match(xml, /\{\{TITULO\}\}/);
  assert.match(xml, /\{\{AUTOR\}\}/);
  assert.match(xml, /\{\{ASESOR\}\}/);
  assert.match(xml, /\{\{CARRERA\|Psicología\}\}/);
  assert.match(xml, /\{\{AÑO\}\}/);
});

test('los datos de ejemplo y las instrucciones no se guardan', async () => {
  const partes = await portadaAuto.prepararPortada(partesDePlantilla.extraer(docx(CARATULA_UNFV)), {
    clasificar: sinGemini,
  });
  const guardado = JSON.stringify(partes);

  for (const ajeno of ['SOLIS', 'SANCHEZ', 'SATISFACCIÓN LABORAL', 'Aquí debe ir', 'El nombre de su Asesor']) {
    assert.ok(!guardado.includes(ajeno), `no se guarda «${ajeno}»`);
  }
  assert.ok(guardado.includes('Facultad de Psicología'), 'lo fijo se queda');
  assert.equal(partes.portadaCandidata, undefined);
});

test('el dato hereda el formato de su corrida, no el de la instrucción', async () => {
  const partes = await portadaAuto.prepararPortada(partesDePlantilla.extraer(docx(CARATULA_UNFV)), {
    clasificar: sinGemini,
  });
  const asesor = [...partes.portada.xml.matchAll(partesDePlantilla.PARRAFO_INTERIOR_RE)]
    .map((m) => m[0])
    .find((p) => p.includes('{{ASESOR}}'));

  assert.match(asesor, /<w:b\/><\/w:rPr><w:t xml:space="preserve">\{\{ASESOR\}\}<\/w:t>/, 'en la negrita del nombre');
  assert.match(asesor, new RegExp(`${ROJO}<w:t xml:space="preserve"></w:t>`), 'la instrucción roja queda vacía');
});

// ── Con Gemini ─────────────────────────────────────────────────────────────

test('con Gemini se usa lo que dice, y lo que no está tal cual en la línea se descarta', async () => {
  const extraidas = partesDePlantilla.extraer(docx(CARATULA_UNFV));
  const lineas = portadaAuto.lineasDe(extraidas.portadaCandidata.xml);
  const numero = (trozo) => lineas.find((l) => l.texto.includes(trozo)).linea;

  const partes = await portadaAuto.prepararPortada(extraidas, {
    clasificar: async () => [
      { linea: numero('SOLIS'), campo: 'autor', texto: 'SOLIS  PAREDES GABRIELA LÍZBEL' },
      { linea: numero('SANCHEZ'), campo: 'asesor', texto: 'SANCHEZ GÒMEZ, LUIS' },
      { linea: numero('(El nombre'), campo: 'instruccion', texto: '(El nombre de su Asesor)' },
      // Inventado: no está en esa línea.
      { linea: numero('Facultad'), campo: 'titulo', texto: 'Un título que no existe' },
      { linea: 999, campo: 'anio', texto: '20' },
      { linea: numero('Lima'), campo: 'otra-cosa', texto: 'Lima' },
    ],
  });

  assert.deepEqual(partes.camposDePortada, ['autor', 'asesor']);
  assert.ok(JSON.stringify(partes).includes('Facultad de Psicología'));
});

test('un segundo autor se borra en vez de repetir el nombre', () => {
  const lineas = [
    { linea: 0, texto: 'Ana Pérez' },
    { linea: 1, texto: 'Luis Soto' },
  ];
  const validos = portadaAuto.validar(
    [
      { linea: 0, campo: 'autor', texto: 'Ana Pérez' },
      { linea: 1, campo: 'autor', texto: 'Luis Soto' },
    ],
    lineas,
  );
  assert.deepEqual(validos.map((c) => c.campo), ['autor', 'instruccion']);
});

test('si no se reconoce nada, la portada no se usa', async () => {
  const partes = await portadaAuto.prepararPortada(
    partesDePlantilla.extraer(docx(linea('Documento sin nada que parezca una portada'))),
    { clasificar: async () => [] },
  );
  assert.equal(partes.portada, null);
  assert.equal(partes.portadaSinMarcas, true);
});

// ── El Word ────────────────────────────────────────────────────────────────

test('el Word sale con los datos del proyecto en la carátula UNFV', async () => {
  const buffer = docx(CARATULA_UNFV);
  const partes = await portadaAuto.prepararPortada(partesDePlantilla.extraer(buffer), {
    clasificar: sinGemini,
  });

  const word = await armar({
    tema: 'Uso de redes sociales y rendimiento académico',
    nombre: "S'teban Dioses",
    carrera: null,
    asesor: 'Dra. María Quispe',
    estilos: `<w:styles xmlns:w="${W}"></w:styles>`,
    partes,
    capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }],
  });
  const doc = new AdmZip(word).getEntry('word/document.xml').getData().toString('utf8');

  assert.ok(doc.includes('Uso de redes sociales y rendimiento académico'));
  assert.ok(doc.includes("S'teban Dioses"));
  assert.ok(doc.includes('Dra. María Quispe'));
  assert.ok(doc.includes('Licenciada en Psicología'), 'sin carrera guardada, la de la plantilla');
  assert.ok(doc.includes(`>${new Date().getFullYear()}<`));
  assert.ok(!doc.includes('{{'));
  assert.ok(!doc.includes('SOLIS'));
});

test('sin plantilla, nuestra portada lleva el asesor si lo hay', async () => {
  const word = await armar({
    tema: 'Tema',
    nombre: 'Ana',
    asesor: 'Dr. Juan Pérez',
    capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }],
  });
  const doc = new AdmZip(word).getEntry('word/document.xml').getData().toString('utf8');
  assert.ok(doc.includes('Asesor: Dr. Juan Pérez'));
});
