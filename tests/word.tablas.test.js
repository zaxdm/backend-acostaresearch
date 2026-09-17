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

test('una figura: número en negrita, título en cursiva, marca resaltada y nota, sin sangría', async () => {
  const xml = await xmlDe(
    '**Figura 2**\n*Distribución de la motivación*\n[Insertar aquí la Figura 2: histograma.png]\n*Nota.* Elaboración propia.',
  );
  assert.match(xml, /<w:b\/>(?:<w:bCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>Figura 2<\/w:t>/);
  assert.match(xml, /<w:i\/>(?:<w:iCs\/>)?<\/w:rPr><w:t(?: [^>]*)?>Distribución de la motivación<\/w:t>/);
  assert.match(xml, /<w:highlight w:val="yellow"\/>(?:[^<]|<(?!\/w:r>))*Insertar aquí la Figura 2: histograma\.png/);
  assert.ok(textos(xml).includes('Nota.'));
  // Ningún párrafo del rótulo con la sangría de primera línea del texto normal.
  const parrafoDelNumero = xml.match(/<w:p>(?:(?!<\/w:p>).)*Figura 2<\/w:t>/)[0];
  assert.doesNotMatch(parrafoDelNumero, /w:firstLine="[1-9]/, 'la única sangría de primera línea permitida es cero');
});

test('la imagen en Markdown del informe de R sale como la misma marca, con su archivo', async () => {
  const xml = await xmlDe('**Figura 1**\n*Histograma*\n![](figura1.png)');
  assert.ok(textos(xml).includes('[Insertar aquí la Figura 1: figura1.png]'), textos(xml).join(' | '));
  assert.ok(!textos(xml).some((t) => t.includes('![](')));
});

test('una frase que empieza por «Figura» dentro de un párrafo sigue siendo texto', async () => {
  const xml = await xmlDe('Figura 1 muestra la distribución de la muestra por edad.');
  assert.ok(textos(xml).some((t) => t.includes('Figura 1 muestra la distribución')));
  assert.ok(!xml.includes('w:highlight'));
});

test('unas líneas con barras pero sin fila de guiones siguen siendo texto', async () => {
  const xml = await xmlDe('| esto no es | una tabla |\n| sin separador |');
  assert.ok(!xml.includes('<w:tbl>'));
  assert.ok(textos(xml).some((t) => t.includes('| esto no es | una tabla |')));
});

// ── El ancho de las columnas ────────────────────────────────────────────────

/** Los anchos de la rejilla de la primera tabla del documento. */
const rejilla = (xml) =>
  [...(xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/) ?? [''])[0].matchAll(/w:w="(\d+)"/g)].map((m) => Number(m[1]));

test('las columnas se reparten por lo que llevan dentro, no por igual', async () => {
  const xml = await xmlDe(
    [
      '**Tabla 1**',
      '| Pregunta de investigación | Sí |',
      '|---|---|',
      '| ¿Cómo influye el clima laboral en el desempeño del personal asistencial? | No |',
    ].join('\n'),
  );

  const anchos = rejilla(xml);
  assert.equal(anchos.length, 2);
  assert.ok(anchos[0] > anchos[1] * 2, `la columna larga se lleva más: ${anchos.join(' / ')}`);
  // Con el reparto automático Word vuelve a decidir por su cuenta y la rejilla
  // no sirve de nada: el diseño tiene que ser fijo.
  assert.match(xml, /<w:tblLayout w:type="fixed"\/>/);
  assert.match(xml, /<w:tcW w:type="dxa" w:w="\d+"\/>/);
});

test('la tabla no se pasa del ancho de la hoja ni deja una columna sin sitio', () => {
  const { anchosDeColumna } = documento;
  const util = 8788;

  const dos = anchosDeColumna([['Una pregunta larguísima de cuarenta y tantos caracteres', 'Sí']], 2, util);
  assert.equal(dos.reduce((a, b) => a + b, 0), util, 'la suma cuadra con el ancho útil');
  assert.ok(Math.min(...dos) >= 720, 'ninguna columna baja del mínimo');

  // Veinte columnas no caben ni al mínimo: se reparten por igual y que Word
  // ajuste, que es lo que hacía antes de que hubiera anchos.
  const muchas = anchosDeColumna([Array.from({ length: 20 }, () => 'x')], 20, util);
  assert.equal(muchas.length, 20);
  assert.ok(muchas.every((a) => a === muchas[0]));
  assert.ok(muchas.reduce((a, b) => a + b, 0) <= util);
});

test('con la plantilla de la facultad, la tabla mide lo que da su margen', async () => {
  const buffer = await documento.armar({
    tema: 'Tema',
    nombre: 'Alguien',
    // Media carta, con márgenes anchos: 9360 - 2000 - 2000 = 5360.
    pagina: { tamano: { width: 9360, height: 12240 }, margen: { top: 1440, right: 2000, bottom: 1440, left: 2000 } },
    capitulos: [{ titulo: 'Capítulo I', texto: '**Tabla 1**\n| A | B |\n|---|---|\n| 1 | 2 |' }],
  });
  const xml = new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');

  assert.equal(rejilla(xml).reduce((a, b) => a + b, 0), 5360);
});
