'use strict';

/**
 * El formato del curso en el informe estudiantil.
 *
 * Lo que tiene que ser cierto:
 *
 *   · en una carátula de informe se reconocen curso, docente e integrantes, y el
 *     Word sale con esos datos puestos;
 *   · una carátula de tesis se sigue leyendo igual, y sus datos no cambian;
 *   · fuera del informe, esas etiquetas NO se buscan;
 *   · la herramienta del conector habla del curso en el informe y de la
 *     universidad en la tesis.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const partesDePlantilla = require('../src/modules/projects/project.plantilla-partes');
const portadaAuto = require('../src/modules/projects/project.portada-auto');
const { armar } = require('../src/modules/projects/project.docx');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const linea = (texto) => `<w:p><w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>`;

/** Una carátula de trabajo de curso, como las de un instituto. */
const CARATULA_INFORME = [
  linea('INSTITUTO SUPERIOR TECNOLÓGICO'),
  linea('Programa de Administración de Empresas'),
  linea('LA INFORMALIDAD LABORAL EN LOS MERCADOS DE LIMA'),
  linea('Curso: Economía General'),
  linea('Docente: Mg. Rosa Díaz'),
  linea('Integrantes: Pérez Quispe, Juan'),
  linea('Ciclo: IV - Sección B'),
  linea('Lima – Perú'),
].join('');

/** La misma carátula de tesis que vigila `proyecto.portada-auto`. */
const CARATULA_TESIS = [
  linea('Facultad de Psicología'),
  linea('SATISFACCIÓN LABORAL Y COMPROMISO ORGANIZACIONAL'),
  linea('Tesis para optar el título profesional de Licenciada en Psicología'),
  linea('AUTOR'),
  linea('SOLIS PAREDES GABRIELA LÍZBEL'),
  linea('ASESOR'),
  linea('SANCHEZ GÒMEZ, LUIS'),
  linea('Lima – Perú'),
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

const preparar = (cuerpo, tipo) =>
  portadaAuto.prepararPortada(partesDePlantilla.extraer(docx(cuerpo)), { clasificar: sinGemini, tipo });

const visible = (buffer) => new AdmZip(buffer).readAsText('word/document.xml').replace(/<[^>]+>/g, '');

test('en un informe se reconocen curso, docente, integrantes y ciclo', async () => {
  const partes = await preparar(CARATULA_INFORME, 'informe');
  assert.ok(partes.portada, 'la portada se usa');
  for (const campo of ['curso', 'docente', 'integrantes']) {
    assert.ok(partes.camposDePortada.includes(campo), `falta ${campo}: ${partes.camposDePortada}`);
  }
});

test('fuera del informe, esas etiquetas no se buscan', async () => {
  const partes = await preparar(CARATULA_INFORME, 'tesis');
  const suyos = partes.camposDePortada ?? [];
  for (const campo of ['curso', 'docente', 'integrantes', 'cicloSeccion']) {
    assert.ok(!suyos.includes(campo), `no debería marcar ${campo} en una tesis`);
  }
});

test('la carátula de tesis se lee igual con el tipo del informe o sin él', async () => {
  const comoSiempre = await preparar(CARATULA_TESIS, undefined);
  const comoInforme = await preparar(CARATULA_TESIS, 'informe');
  assert.deepEqual(comoSiempre.camposDePortada, ['titulo', 'autor', 'asesor', 'carrera']);
  assert.deepEqual(comoInforme.camposDePortada, comoSiempre.camposDePortada);
});

test('el Word del informe sale con el curso, el docente y los integrantes de la ficha', async () => {
  const partes = await preparar(CARATULA_INFORME, 'informe');
  const buffer = await armar({
    tema: 'La informalidad laboral en Lima',
    carrera: 'Administración de Empresas',
    universidad: 'Tecsup',
    nombre: 'Ana Ruiz',
    partes,
    portadaInforme: {
      curso: 'Economía General',
      docente: 'Mg. Rosa Díaz',
      cicloSeccion: 'IV ciclo, sección B',
      integrantes: [
        { nombre: 'Ana Ruiz', codigo: 'U2023001' },
        { nombre: 'Luis Soto' },
      ],
    },
    capitulos: [{ titulo: 'Fase 2 — Desarrollo', texto: 'Las causas son varias.' }],
  });

  const texto = visible(buffer);
  assert.match(texto, /Economía General/);
  assert.match(texto, /Mg\. Rosa Díaz/);
  assert.match(texto, /Ana Ruiz \(U2023001\), Luis Soto/);
  assert.doesNotMatch(texto, /Pérez Quispe/, 'el integrante de ejemplo no se queda');
});

test('la portada de una tesis con plantilla no cambia', async () => {
  const partes = await preparar(CARATULA_TESIS, 'tesis');
  const texto = visible(
    await armar({
      tema: 'Deserción universitaria',
      carrera: 'Psicología',
      universidad: 'UNFV',
      nombre: 'Juan Pérez',
      asesor: 'Dra. Ana Ruiz',
      partes,
      capitulos: [{ titulo: '2 · Capítulo I', texto: 'El problema.' }],
    }),
  );
  assert.match(texto, /Deserción universitaria/);
  assert.match(texto, /Juan Pérez/);
  assert.match(texto, /Dra\. Ana Ruiz/);
  assert.doesNotMatch(texto, /SOLIS  ?PAREDES/, 'el autor de ejemplo no se queda');
});
