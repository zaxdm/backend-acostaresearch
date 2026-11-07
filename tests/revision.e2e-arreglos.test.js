'use strict';

/**
 * Arreglos del E2E de la revisión en claude.ai (6-nov-2026).
 *
 * - El Word de una revisión sale como manuscrito: título arriba, sin portada
 *   con «Autor:» y sin índice.
 * - El CSV y el RIS del corpus dicen si hay copia gratis y dónde está el PDF,
 *   para no abrir cada DOI en la web al pedir el texto completo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const { armar } = require('../src/modules/projects/project.docx');
const mapeo = require('../src/modules/scopus/scopus.mapeo');
const corpus = require('../src/modules/references/corpus.revision');

const DATOS = {
  tema: 'Tecnoestrés y trabajo docente: revisión sistemática',
  nombre: 'Tesista de Prueba',
  capitulos: [
    { titulo: 'Introducción', texto: 'El tecnoestrés afecta al docente.' },
    { titulo: 'Método', texto: 'Se siguió PRISMA 2020.' },
  ],
  referencias: [],
};

const xmlDe = async (datos) => new AdmZip(await armar(datos)).readAsText('word/document.xml');

test('el Word de una revisión no lleva portada ni índice, y sí el título', async () => {
  const xml = await xmlDe({ ...DATOS, manuscrito: true });
  assert.ok(xml.includes('Tecnoestrés y trabajo docente: revisión sistemática'));
  assert.ok(!xml.includes('Autor: '), 'no lleva la portada con «Autor:»');
  assert.ok(!xml.includes('>Índice<'), 'no lleva índice');
  assert.ok(!/TOC \h/.test(xml), 'no lleva el campo del índice');
  assert.ok(!xml.includes('<w:pageBreakBefore/>'), 'las secciones van seguidas');
});

test('sin «manuscrito» el Word sigue con portada e índice', async () => {
  const xml = await xmlDe(DATOS);
  assert.ok(xml.includes('Autor: '));
  assert.ok(xml.includes('>Índice<'));
});

const OBRA = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1234/abc',
  display_name: 'Technostress and performance',
  publication_year: 2024,
  authorships: [],
  open_access: { is_oa: true, oa_url: 'https://revista.org/abc' },
  best_oa_location: { pdf_url: 'https://revista.org/abc.pdf' },
};

test('el CSV del corpus trae las columnas de acceso abierto al final', () => {
  const [cabecera, fila] = mapeo.csvDeOpenAlex([OBRA]).trim().split('\n');
  const columnas = cabecera.split(',').map((c) => c.replace(/"/g, ''));
  assert.deepEqual(columnas.slice(-3), ['open_access.is_oa', 'open_access.oa_url', 'best_oa_location.pdf_url']);
  assert.equal(columnas[columnas.length - 4], 'abstract', 'las de bibliometrix no se mueven');
  assert.ok(fila.endsWith('"true","https://revista.org/abc","https://revista.org/abc.pdf"'));
});

test('el RIS lleva el PDF gratis en L1', () => {
  const ris = corpus.ris([corpus.deOpenAlex(OBRA, 'OpenAlex')]);
  assert.match(ris, /L1 {2}- https:\/\/revista\.org\/abc\.pdf/);
  const sinPdf = corpus.ris([corpus.deOpenAlex({ ...OBRA, best_oa_location: null }, 'OpenAlex')]);
  assert.doesNotMatch(sinPdf, /L1 {2}-/);
});
