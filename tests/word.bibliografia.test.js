'use strict';

/**
 * Que el Word se siga generando después de tocar la bibliografía.
 *
 * POR QUÉ ESTA PRUEBA EXISTE
 * --------------------------
 * Al poner las cursivas, la lista de referencias dejó de ser un array de textos
 * y pasó a ser un array de tramos: `{ texto, tramos: [{ texto, cursiva }] }`.
 * El armador del documento tuvo que cambiar con ella.
 *
 * Eso es un cambio de FORMA entre dos módulos, y esos no los caza ninguna
 * prueba de las que miran cada módulo por su lado: la de las citas comprueba
 * que los tramos salen bien, y la del Word —que no existía— habría comprobado
 * que se pintan. En medio queda el hueco por el que se cuela un documento que
 * revienta al descargarlo, y de eso no se entera nadie hasta que un tesista
 * pulsa el botón.
 *
 * Así que esto arma un .docx de verdad, con la salida de verdad de
 * `bibliografia`, y comprueba que sale un archivo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const citas = require('../src/modules/projects/project.citas');
const documento = require('../src/modules/projects/project.docx');

const FUENTES = [
  {
    ref: 'AR11111111',
    itemType: 'journalArticle',
    authors: 'Hernández, R.; Fernández, C.',
    year: 2024,
    title: 'Clima organizacional y desempeño',
    source: 'Revista de Educación',
    volume: '15',
    issue: '2',
    pages: '45-62',
    doi: '10.1234/re.2024.001',
  },
  {
    ref: 'AR22222222',
    itemType: 'book',
    authors: 'Torres, M.',
    year: 2020,
    title: 'Metodología de la investigación',
    source: 'Editorial Andina',
  },
  // Una de las viejas: sin tipo, sin volumen y sin páginas, como las miles que
  // ya estaban guardadas antes de que existieran esas columnas.
  {
    ref: 'AR33333333',
    authors: 'Vargas, L.',
    year: 2021,
    title: 'Una fuente de antes',
    source: 'Revista Vieja',
    doi: '10.9/y',
  },
];

test('el .docx se arma con la bibliografía en tramos, y pesa lo que pesa un docx', async () => {
  const referencias = citas.bibliografiaConCursivas(FUENTES);

  // La forma es la que espera el armador: cada entrada con sus tramos.
  assert.ok(Array.isArray(referencias[0].tramos), 'cada entrada baja partida en tramos');

  const buffer = await documento.armar({
    tema: 'Clima organizacional en una municipalidad',
    carrera: 'Administración',
    universidad: 'Universidad Nacional de Trujillo',
    nombre: 'Benicio Acosta',
    capitulos: [{ titulo: 'Capítulo I', texto: 'Un párrafo cualquiera.' }],
    referencias,
  });

  assert.ok(Buffer.isBuffer(buffer), 'tiene que salir un archivo, no un objeto a medias');
  // Un .docx es un ZIP: empieza por «PK».
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 5000, `el documento salió sospechosamente corto: ${buffer.length} bytes`);
});

test('el armador aguanta también una lista de textos pelados', async () => {
  // No es teórico: cualquier otro sitio que arme referencias sin tramos —o una
  // versión anterior en caché tras un despliegue a medias— pasaría cadenas.
  const buffer = await documento.armar({
    tema: 'Un tema',
    carrera: 'Una carrera',
    universidad: 'Una universidad',
    nombre: 'Alguien',
    capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }],
    referencias: FUENTES.map(citas.entradaDeBibliografia),
  });

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
});

test('sin referencias, el documento sale igual', async () => {
  const buffer = await documento.armar({
    tema: 'Un tema',
    carrera: 'Una carrera',
    universidad: 'Una universidad',
    nombre: 'Alguien',
    capitulos: [{ titulo: 'Capítulo I', texto: 'Texto.' }],
    referencias: [],
  });

  assert.ok(Buffer.isBuffer(buffer));
});
