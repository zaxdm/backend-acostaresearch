'use strict';

/**
 * Qué archivo subió el tesista y con qué orden lo lee R.
 *
 * Los casos son los archivos que salen de verdad de un Excel en español: el
 * punto y coma, la coma decimal, el «sep=;» de la primera línea, la marca de
 * UTF-8 y la codificación antigua de Windows. Cada uno, leído mal, no da error:
 * da una matriz equivocada que se ve bien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const formato = require('../src/modules/r/r.formato');

const bytes = (texto, codificacion = 'utf8') => Buffer.from(texto, codificacion);

test('un .xlsx se reconoce por sus bytes y se lee con readxl', () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
  const p = formato.preparar(zip);

  assert.equal(p.tipo, 'xlsx');
  assert.equal(p.archivo, 'datos.xlsx');
  assert.match(p.lectura, /readxl::read_excel\("datos\.xlsx"\)/);
  assert.match(p.lectura, /make\.names/, 'sin esto, «Me gusta» obliga a comillas invertidas');
});

test('un .xlsx renombrado a .csv sigue siendo un Excel', () => {
  // La extensión no se mira nunca: solo los bytes.
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(10)]);
  assert.equal(formato.tipoDe(zip), 'xlsx');
});

test('el CSV del Excel en español: sep=; delante, punto y coma y coma decimal', () => {
  const p = formato.preparar(bytes('sep=;\r\nid;sexo;p1\r\n1;F;3,5\r\n2;M;4\r\n'));

  assert.equal(p.archivo, 'datos.csv');
  assert.equal(p.lectura, 'datos <- read.csv("datos.csv", sep = ";", dec = ",")');
  assert.ok(p.contenido.toString('utf8').startsWith('id;sexo;p1'), 'el sep=; no llega a R');
  assert.match(p.aviso, /punto y coma/);
});

test('punto y coma con decimales de punto no pide dec', () => {
  const p = formato.preparar(bytes('id;edad;p1\n1;20;3.5\n'));
  assert.equal(p.lectura, 'datos <- read.csv("datos.csv", sep = ";")');
});

test('un CSV con comas se lee con read.csv a secas', () => {
  const p = formato.preparar(bytes('id,edad,p1\n1,20,3.5\n'));
  assert.equal(p.lectura, 'datos <- read.csv("datos.csv")');
  assert.equal(p.aviso, null);
});

test('la marca de UTF-8 se quita y no se confunde con datos', () => {
  const conBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes('sep=;\nid;p1\n1;2\n')]);
  const p = formato.preparar(conBom);
  assert.ok(p.contenido.toString('utf8').startsWith('id;p1'));
});

test('las comas dentro de comillas no separan columnas', () => {
  assert.equal(formato.separadorDe('"Apellidos, nombre";edad;sexo'), ';');
});

test('un texto separado por tabuladores se lee con sep = "\\t"', () => {
  const p = formato.preparar(bytes('id\tedad\tp1\n1\t20\t3\n'));
  assert.equal(p.lectura, 'datos <- read.csv("datos.csv", sep = "\\t")');
});

test('el CSV en la codificación antigua de Windows se lee como latin1', () => {
  // «CSV (delimitado por comas)» del Excel de Windows: la ñ es un solo byte.
  const p = formato.preparar(bytes('id;género;año\n1;F;2024\n', 'latin1'));
  assert.equal(p.lectura, 'datos <- read.csv("datos.csv", sep = ";", fileEncoding = "latin1")');
  assert.match(p.aviso, /codificación antigua/);
});

test('un CSV en UTF-8 con tildes no se toma por latin1', () => {
  const p = formato.preparar(bytes('id;género\n1;F\n'));
  assert.doesNotMatch(p.lectura, /fileEncoding/);
});

test('un .sav de SPSS se lee con haven y sin etiquetas de valor', () => {
  const sav = Buffer.concat([bytes('$FL2@(#) IBM SPSS STATISTICS'), Buffer.alloc(40)]);
  const p = formato.preparar(sav);

  assert.equal(p.tipo, 'sav');
  assert.equal(p.archivo, 'datos.sav');
  assert.match(p.lectura, /haven::zap_labels\(haven::read_sav\("datos\.sav"\)\)/);
  assert.doesNotMatch(p.lectura, /as_factor/, 'un ítem Likert tiene que quedar como número');
  assert.match(p.aviso, /SPSS/);
});

test('un .zsav comprimido también es SPSS', () => {
  assert.equal(formato.tipoDe(Buffer.concat([bytes('$FL3'), Buffer.alloc(20)])), 'sav');
});

test('un PDF o una imagen no es una hoja de datos', () => {
  const pdf = Buffer.concat([bytes('%PDF-1.7\n'), Buffer.from([0x00, 0x01, 0x02])]);
  assert.throws(() => formato.preparar(pdf), formato.ArchivoNoValido);
  assert.throws(() => formato.preparar(Buffer.alloc(0)), formato.ArchivoNoValido);
});
