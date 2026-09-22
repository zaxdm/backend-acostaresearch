'use strict';

/**
 * En el Word: primero las referencias y después los anexos.
 *
 * Es el orden de cualquier reglamento —la bibliografía cierra el cuerpo del
 * trabajo y los anexos son material de apoyo— y el Word lo hacía al revés: los
 * capítulos salían en el orden del esquema y la lista de referencias se pegaba
 * al final de todos, así que la facultad que ponía «ANEXOS» como último
 * capítulo recibía su tesis con las referencias detrás de los anexos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { armar } = require('../src/modules/projects/project.docx');

/** Los Título 1 del documento, en el orden en que están impresos. */
async function titulosDelWord(datos) {
  const zip = new AdmZip(await armar(datos));
  const xml = zip.readAsText('word/document.xml');
  return [...xml.matchAll(/<w:pStyle w:val="Heading1"\/>[\s\S]*?<w:t[^>]*>([^<]*)<\/w:t>/g)].map(
    (m) => m[1],
  );
}

const TESIS = {
  tema: 'Deserción universitaria en el primer año',
  carrera: 'Psicología',
  universidad: 'Universidad Nacional Mayor de San Marcos',
  nombre: 'Juan Pérez Quispe',
  referencias: ['García, A. (2024). Deserción y permanencia. Lima: UNMSM.'],
};

test('los anexos salen detrás de la lista de referencias', async () => {
  const titulos = await titulosDelWord({
    ...TESIS,
    capitulos: [
      { titulo: 'CAPÍTULO I: PROBLEMA', texto: 'El problema es la deserción.' },
      { titulo: 'ANEXO 1: INSTRUMENTO', anexo: true, texto: 'Cuestionario de 20 ítems.' },
      { titulo: 'CAPÍTULO II: MARCO TEÓRICO', texto: 'García (2024) encontró que…' },
    ],
  });

  assert.deepEqual(titulos, [
    'CAPÍTULO I: PROBLEMA',
    'CAPÍTULO II: MARCO TEÓRICO',
    'Referencias',
    'ANEXO 1: INSTRUMENTO',
  ]);
});

test('un capítulo que se llama anexo lo es aunque nadie lo haya marcado', async () => {
  // Otras llamadas a `armar` pasan solo título y texto; la regla no puede
  // depender de por dónde haya entrado el capítulo.
  const titulos = await titulosDelWord({
    ...TESIS,
    capitulos: [
      { titulo: 'Anexos', texto: 'Matriz de consistencia.' },
      { titulo: 'CAPÍTULO I: PROBLEMA', texto: 'El problema es la deserción.' },
    ],
  });

  assert.deepEqual(titulos, ['CAPÍTULO I: PROBLEMA', 'Referencias', 'Anexos']);
});

test('sin anexos, el Word sale como salía: los capítulos y las referencias al final', async () => {
  const titulos = await titulosDelWord({
    ...TESIS,
    capitulos: [
      { titulo: 'CAPÍTULO I: PROBLEMA', texto: 'El problema es la deserción.' },
      { titulo: 'CAPÍTULO II: MARCO TEÓRICO', texto: 'García (2024) encontró que…' },
    ],
  });

  assert.deepEqual(titulos, ['CAPÍTULO I: PROBLEMA', 'CAPÍTULO II: MARCO TEÓRICO', 'Referencias']);
});

test('sin referencias, los anexos siguen yendo al final', async () => {
  const titulos = await titulosDelWord({
    ...TESIS,
    referencias: [],
    capitulos: [
      { titulo: 'ANEXO 1: INSTRUMENTO', anexo: true, texto: 'Cuestionario de 20 ítems.' },
      { titulo: 'CAPÍTULO I: PROBLEMA', texto: 'El problema es la deserción.' },
    ],
  });

  assert.deepEqual(titulos, ['CAPÍTULO I: PROBLEMA', 'ANEXO 1: INSTRUMENTO']);
});
