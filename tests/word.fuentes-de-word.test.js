'use strict';

/**
 * Las fuentes en el gestor de citas del propio Word.
 *
 * Un comprador abrió «Referencias → Administrar fuentes», lo encontró vacío y
 * escribió «no aparece citado». El Word lleva ahora dentro la lista de lo que
 * se citó, en el formato de Word. Aquí se abre el .docx de verdad y se
 * comprueba que la pieza está, que Word la va a encontrar (relación y tipo de
 * contenido) y que no rompe lo demás: un paquete mal enlazado es un «el archivo
 * está dañado» en la pantalla de alguien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.docx');
const fuentesDeWord = require('../src/modules/projects/project.fuentes-word');

const ARTICULO = {
  ref: 'AR11111111',
  itemType: 'journalArticle',
  title: 'Estrés docente & factores <psicosociales>',
  authors: 'Alvites-Huamaní, C. G.',
  year: 2019,
  source: 'Propósitos y Representaciones',
  volume: '7',
  issue: '3',
  pages: '141-178',
  doi: '10.20511/pyr2019.v7n3.393',
};

const LIBRO = {
  ref: 'AR22222222',
  itemType: 'book',
  title: 'Metodología de la investigación',
  authors: 'Hernández-Sampieri, R.; Mendoza Torres, C. P.',
  year: 2018,
  source: 'McGraw-Hill',
};

const TESIS = {
  ref: 'AR33333333',
  itemType: 'masterThesis',
  title: 'Rumiación en docentes',
  authors: 'Pérez, A.',
  year: 2021,
  source: 'Universidad de Costa Rica',
  url: 'https://repositorio.example/123',
};

const INSTITUCION = { ref: 'AR44444444', itemType: 'report', title: 'Informe anual', authors: 'Ministerio de Educación Pública', year: 2022 };

const leer = (buffer, parte) => new AdmZip(buffer).getEntry(parte)?.getData().toString('utf8') ?? null;

async function word(extra = {}) {
  return documento.armar({
    tema: 'Rumiación cognitiva en docentes',
    carrera: 'Psicología',
    universidad: 'Universidad de prueba',
    nombre: 'Ana Pérez',
    capitulos: [{ titulo: 'Problema y objetivos', texto: 'La docencia figura entre las profesiones con mayor carga.' }],
    ...extra,
  });
}

test('el Word lleva la lista de fuentes donde la busca «Administrar fuentes»', async () => {
  const buffer = await word({ fuentes: [ARTICULO, LIBRO], norma: 'apa' });

  const lista = leer(buffer, 'customXml/item1.xml');
  assert.ok(lista, 'falta la pieza con las fuentes');
  assert.equal((lista.match(/<b:Source>/g) ?? []).length, 2);
  assert.match(lista, /<b:Last>Alvites-Huamaní<\/b:Last><b:First>C\. G\.<\/b:First>/);
  assert.match(lista, /<b:JournalName>Propósitos y Representaciones<\/b:JournalName>/);
  assert.match(lista, /<b:Year>2019<\/b:Year>/);
  assert.match(lista, /StyleName="APA"/);
});

test('Word la encuentra: relación desde el documento, propiedades y tipo de contenido', async () => {
  const buffer = await word({ fuentes: [ARTICULO] });

  assert.match(leer(buffer, 'word/_rels/document.xml.rels'), /relationships\/customXml" Target="\.\.\/customXml\/item1\.xml"/);
  assert.match(leer(buffer, 'customXml/_rels/item1.xml.rels'), /Target="itemProps1\.xml"/);
  assert.match(leer(buffer, 'customXml/itemProps1.xml'), /officeDocument\/2006\/bibliography/);
  assert.match(leer(buffer, '[Content_Types].xml'), /PartName="\/customXml\/itemProps1\.xml"/);
});

test('lo que rompería el XML se escapa', () => {
  const xml = fuentesDeWord.fuenteDeWord(ARTICULO, 1);
  assert.match(xml, /Estrés docente &amp; factores &lt;psicosociales&gt;/);
});

test('cada tipo va en el suyo: el libro con editorial, la tesis con su institución', () => {
  const libro = fuentesDeWord.fuenteDeWord(LIBRO, 1);
  assert.match(libro, /<b:SourceType>Book<\/b:SourceType>/);
  assert.match(libro, /<b:Publisher>McGraw-Hill<\/b:Publisher>/);
  assert.equal((libro.match(/<b:Person>/g) ?? []).length, 2);

  const tesis = fuentesDeWord.fuenteDeWord(TESIS, 2);
  assert.match(tesis, /<b:SourceType>Report<\/b:SourceType>/);
  assert.match(tesis, /<b:Institution>Universidad de Costa Rica<\/b:Institution>/);
  assert.match(tesis, /<b:URL>https:\/\/repositorio\.example\/123<\/b:URL>/);
});

test('una institución es autor corporativo, no un apellido', () => {
  assert.match(fuentesDeWord.fuenteDeWord(INSTITUCION, 1), /<b:Corporate>Ministerio de Educación Pública<\/b:Corporate>/);
});

test('una fuente citada veinte veces sale una sola vez', async () => {
  const buffer = await word({ fuentes: [ARTICULO, ARTICULO, LIBRO, ARTICULO] });
  assert.equal((leer(buffer, 'customXml/item1.xml').match(/<b:Source>/g) ?? []).length, 2);
});

test('sin fuentes el Word sale como antes, sin pieza de más', async () => {
  const buffer = await word();
  assert.equal(leer(buffer, 'customXml/item1.xml'), null);
  assert.doesNotMatch(leer(buffer, 'word/_rels/document.xml.rels'), /customXml/);
});

test('el estilo de Word es el más cercano a la norma; lo que no trae, APA', () => {
  assert.equal(fuentesDeWord.estiloDeWord('ieee').nombre, 'IEEE');
  assert.equal(fuentesDeWord.estiloDeWord('chicago-author-date').nombre, 'Chicago');
  assert.equal(fuentesDeWord.estiloDeWord('nlm-citation-sequence').nombre, 'APA');
});

test('si el Word ya traía su bibliografía de Word, no se pisa', async () => {
  const primero = await word({ fuentes: [ARTICULO] });
  const segundo = fuentesDeWord.incrustar(primero, [LIBRO]);
  assert.equal(leer(segundo, 'customXml/item2.xml'), null);
  assert.match(leer(segundo, 'customXml/item1.xml'), /Alvites-Huamaní/);
});
