'use strict';

/**
 * La portada de tesis con el sitio del logo, y el jurado, la dedicatoria y los
 * agradecimientos entre la portada y el índice, como en la plantilla de la UNT
 * (`documentacion/formato-por-defecto/ejemplo`). El artículo y los informes no
 * los llevan.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { armar } = require('../src/modules/projects/project.docx');

const DATOS = {
  tema: 'Deserción universitaria en el primer año',
  carrera: 'Psicología',
  universidad: 'Universidad Nacional de Trujillo',
  nombre: 'Juan Pérez Quispe',
  capitulos: [{ titulo: 'Capítulo I · Problema', texto: 'El problema es la deserción.' }],
};

/** Los textos de la portada al índice, en orden. */
async function hastaElIndice(datos) {
  const xml = new AdmZip(await armar(datos)).readAsText('word/document.xml');
  const antes = xml.slice(0, xml.indexOf('>Índice<'));
  return [...antes.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).filter(Boolean);
}

test('la tesis lleva el sitio del logo y, antes del índice, jurado, dedicatoria y agradecimientos', async () => {
  const textos = await hastaElIndice({ ...DATOS, paginasDeTesis: true });

  const posicion = (t) => textos.indexOf(t);
  assert.ok(posicion('Logo de la universidad') > posicion('PSICOLOGÍA'), 'el logo, debajo de la carrera');
  assert.ok(posicion('Logo de la universidad') < posicion(DATOS.tema), 'y encima del título');
  assert.deepEqual(textos.slice(posicion('Jurado evaluador')), [
    'Jurado evaluador',
    'Presidente: ____________________',
    'Secretario: ____________________',
    'Vocal: ____________________',
    'Dedicatoria',
    'Texto.',
    'Agradecimientos',
    'Texto.',
  ]);
});

test('las hojas preliminares no entran en el índice', async () => {
  const xml = new AdmZip(await armar({ ...DATOS, paginasDeTesis: true })).readAsText('word/document.xml');
  for (const titulo of ['Jurado evaluador', 'Dedicatoria', 'Agradecimientos']) {
    assert.match(xml, new RegExp(`<w:pStyle w:val="TOCHeading"/>[^]*?>${titulo}<`));
    assert.doesNotMatch(xml, new RegExp(`<w:pStyle w:val="Heading1"/>(?:(?!</w:p>)[^])*>${titulo}<`));
  }
});

test('sin la marca de tesis —artículo, informe— no sale nada de eso', async () => {
  const textos = await hastaElIndice(DATOS);
  for (const t of ['Logo de la universidad', 'Jurado evaluador', 'Dedicatoria', 'Agradecimientos']) {
    assert.ok(!textos.includes(t), `sin «${t}»`);
  }
});
