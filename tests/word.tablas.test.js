'use strict';

/**
 * Las tablas del capítulo, como tablas de Word en formato APA.
 *
 * Hasta ahora una tabla en Markdown salía en el Word como texto con barras, y
 * por eso las skills armaban su propio Word. Se abre el .docx de verdad y se lee
 * su XML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const csl = require('../src/modules/projects/project.csl');
const documento = require('../src/modules/projects/project.docx');

const FUENTE = {
  ref: 'AR11111111',
  itemType: 'journalArticle',
  title: 'Dropout from higher education',
  authors: 'Tinto, V.',
  year: 1975,
  source: 'Review of Educational Research',
};

const TEXTO = [
  'Un párrafo antes.',
  '',
  '**Tabla 1**',
  '*Matriz de consistencia*',
  '| Problema | Objetivo |',
  '|---|:---:|',
  '| ¿Cómo influye la motivación? | Determinar su efecto [AR11111111] |',
  '| Una barra \\| escapada | **Total** | una celda de más |',
  '*Nota.* Elaboración propia.',
  '',
  'Un párrafo después.',
].join('\n');

async function xmlDe(texto, { conCitas = false } = {}) {
  let capitulos = [{ titulo: 'Capítulo I', texto }];
  let citas = null;
  if (conCitas) {
    const r = csl.renderizar({ norma: 'apa', porClave: new Map([[FUENTE.ref, FUENTE]]), capitulos });
    capitulos = [{ titulo: 'Capítulo I', texto: r.textos[0] }];
    citas = r.citas;
  }
  const buffer = await documento.armar({ tema: 'Tema', nombre: 'Alguien', capitulos, citas });
  return new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
}

/** El texto de cada <w:t>, en orden. */
const textos = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);

test('una tabla en Markdown sale como tabla de Word, sin barras', async () => {
  const xml = await xmlDe(TEXTO);
  assert.equal([...xml.matchAll(/<w:tbl>/g)].length, 1);
  assert.equal([...xml.matchAll(/<w:tr[ >]/g)].length, 3, 'cabecera y dos filas');
  assert.ok(!textos(xml).some((t) => t.includes('|---')), 'la fila de guiones no es texto');
  assert.ok(textos(xml).includes('¿Cómo influye la motivación?'));
  assert.ok(textos(xml).includes('Una barra | escapada'));
});

test('formato APA: número en negrita, título en cursiva, sin líneas verticales y con nota', async () => {
  const xml = await xmlDe(TEXTO);
  assert.match(xml, /<w:b\/>(?:<w:bCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>Tabla 1<\/w:t>/);
  assert.match(xml, /<w:i\/>(?:<w:iCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>Matriz de consistencia<\/w:t>/);
  assert.match(xml, /<w:insideV w:val="none"/);
  assert.match(xml, /<w:tblHeader\/>/, 'la cabecera se repite si la tabla cambia de página');
  assert.ok(textos(xml).includes('Nota.'));
  assert.ok(!textos(xml).some((t) => t.includes('**')), 'sin asteriscos de Markdown');
});

test('una fila con celdas de más se ajusta a las columnas de la cabecera', async () => {
  const xml = await xmlDe(TEXTO);
  const filas = [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((m) => [...m[0].matchAll(/<w:tc>/g)].length);
  assert.deepEqual(filas, [2, 2, 2]);
});

test('las citas con clave dentro de una celda salen escritas en la norma', async () => {
  const xml = await xmlDe(TEXTO, { conCitas: true });
  assert.ok(textos(xml).some((t) => t.includes('(Tinto, 1975)')), textos(xml).join(' | '));
  assert.ok(!xml.includes('⟦'), 'no queda ningún hueco sin cambiar');
});

test('**negrita** y *cursiva* salen con formato y sin asteriscos; «2 * 3» queda igual', async () => {
  const xml = await xmlDe('El término **motivación** se mide con *p* < .05, y 2 * 3 = 6.');
  assert.match(xml, /<w:b\/>(?:<w:bCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>motivación<\/w:t>/);
  assert.match(xml, /<w:i\/>(?:<w:iCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>p<\/w:t>/);
  assert.ok(!textos(xml).some((t) => t.includes('**')));
  assert.ok(textos(xml).some((t) => t.includes('2 * 3 = 6.')));
});

test('la cursiva funciona también junto a una cita con clave', async () => {
  const xml = await xmlDe('Según el *modelo de Tinto* [AR11111111], la deserción crece.', { conCitas: true });
  assert.match(xml, /<w:i\/>(?:<w:iCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>modelo de Tinto<\/w:t>/);
  assert.ok(textos(xml).some((t) => t.includes('(Tinto, 1975)')));
});

test('unas líneas con barras pero sin fila de guiones siguen siendo texto', async () => {
  const xml = await xmlDe('| esto no es | una tabla |\n| sin separador |');
  assert.ok(!xml.includes('<w:tbl>'));
  assert.ok(textos(xml).some((t) => t.includes('| esto no es | una tabla |')));
});
