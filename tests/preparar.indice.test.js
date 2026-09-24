'use strict';

/**
 * El índice también se traduce.
 *
 * DE DÓNDE SALE ESTA PRUEBA
 * -------------------------
 * De una entrega real (23-sep-2026). El cliente tradujo su tesis al inglés en
 * `preparar-documento` y le llegó todo traducido —las tablas, los rótulos, el
 * pie de página— menos el índice: debajo de un título que ya decía «Table of
 * Contents» seguían «CAPÍTULO I: PROBLEMA Y OBJETIVOS», «Planteamiento del
 * problema» y «Referencias». Es lo primero que se ve al abrir el documento.
 *
 * LO QUE SE FIJA AQUÍ
 * -------------------
 *   · Cada línea del índice queda como quedó el título del que sale.
 *   · El enlace, el tabulador con los puntitos y el campo `PAGEREF` con el
 *     número de página siguen enteros: la línea sigue siendo la del índice, y
 *     Word la puede rehacer cuando quiera.
 *   · Una línea cuyo título no se tradujo se queda como estaba, sin inventar.
 *   · El índice no cuenta como párrafo traducido: es copia de los títulos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const motor = require('../src/modules/preparar/preparar.motor');
const traduccion = require('../src/modules/preparar/preparar.traduccion');
const servicio = require('../src/modules/preparar/preparar.service');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const t = (texto) => `<w:r><w:t xml:space="preserve">${texto}</w:t></w:r>`;
const p = (texto) => `<w:p>${t(texto)}</w:p>`;
const titulo = (texto, nivel = 1) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading${nivel}"/></w:pPr>` +
  `<w:bookmarkStart w:id="1" w:name="_Toc${nivel}00"/>${t(texto)}` +
  '<w:bookmarkEnd w:id="1"/></w:p>';

/** Una línea del índice como la escribe Word: enlace, tabulador con puntitos y PAGEREF. */
const entrada = (texto, pagina, nivel = 1) =>
  `<w:p><w:pPr><w:pStyle w:val="TOC${nivel}"/>` +
  '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8788"/></w:tabs></w:pPr>' +
  `<w:hyperlink w:anchor="_Toc${nivel}00" w:history="1">` +
  `<w:r><w:rPr><w:rStyle w:val="Hipervnculo"/></w:rPr><w:t>${texto}</w:t></w:r>` +
  '<w:r><w:tab/></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
  `<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc${nivel}00 \\h </w:instrText></w:r>` +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
  `<w:r><w:t>${pagina}</w:t></w:r>` +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink></w:p>';

const ESTILOS =
  `<?xml version="1.0"?><w:styles xmlns:w="${W}">` +
  '<w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
  '<w:style w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>' +
  '<w:style w:styleId="TOC2"><w:name w:val="toc 2"/></w:style>' +
  '</w:styles>';

function docx(cuerpoXml) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>${cuerpoXml}</w:body></w:document>`,
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(ESTILOS));
  return zip.toBuffer();
}

const leerCuerpo = (buffer) =>
  new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');

/** Lo que dice cada línea del índice, con el tabulador donde estaba. */
const lineasDelIndice = (xml) =>
  [...xml.matchAll(/<w:p><w:pPr><w:pStyle w:val="TOC\d"[\s\S]*?<\/w:p>/g)].map((m) =>
    m[0]
      .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<[^>]*>/g, ''),
  );

/** Un modelo que traduce con el diccionario que se le pase, y deja lo demás igual. */
const modeloCon = (diccionario) => async ({ mensajes }) => {
  const entrada_ = JSON.parse(mensajes[0].texto);
  return {
    texto: JSON.stringify(
      Object.fromEntries(
        Object.entries(entrada_).map(([id, texto]) => [id, diccionario[texto] ?? `[EN] ${texto}`]),
      ),
    ),
  };
};

async function traducirTodo(buffer, diccionario = {}) {
  const { parrafos } = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('TRADUCCION'));
  const { cambios } = await motor.prepararParrafos({
    parrafos,
    servicio: 'TRADUCCION',
    idioma: 'en',
    generar: modeloCon(diccionario),
    porTanda: 10_000,
  });
  return { ...traduccion.traducir(buffer, cambios, parrafos), parrafos };
}

const DICCIONARIO = {
  'Índice': 'Table of Contents',
  'CAPÍTULO I: PROBLEMA Y OBJETIVOS': 'CHAPTER I: PROBLEM AND OBJECTIVES',
  'Planteamiento del problema': 'Statement of the problem',
  'El estudio parte de una necesidad concreta.': 'The study starts from a concrete need.',
};

// ── El caso del cliente ────────────────────────────────────────────────────

test('las líneas del índice quedan como quedaron sus títulos', async () => {
  const buffer = docx(
    p('Índice') +
      entrada('CAPÍTULO I: PROBLEMA Y OBJETIVOS', 3) +
      entrada('Planteamiento del problema', 3, 2) +
      titulo('CAPÍTULO I: PROBLEMA Y OBJETIVOS') +
      titulo('Planteamiento del problema', 2) +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);

  assert.match(xml, /Table of Contents/);
  assert.deepEqual(lineasDelIndice(xml), [
    'CHAPTER I: PROBLEM AND OBJECTIVES\t3',
    'Statement of the problem\t3',
  ]);
  assert.doesNotMatch(xml, /PROBLEMA Y OBJETIVOS/);
  assert.doesNotMatch(xml, /Planteamiento del problema/);
});

test('la línea sigue siendo la del índice: enlace, puntitos y número de página', async () => {
  const buffer = docx(
    entrada('CAPÍTULO I: PROBLEMA Y OBJETIVOS', 3) +
      titulo('CAPÍTULO I: PROBLEMA Y OBJETIVOS') +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);
  const linea = /<w:p><w:pPr><w:pStyle w:val="TOC1"[\s\S]*?<\/w:p>/.exec(xml)[0];

  assert.match(linea, /<w:hyperlink w:anchor="_Toc100"/);
  assert.match(linea, /w:leader="dot"/);
  assert.match(linea, /<w:tab\/>/);
  assert.match(linea, /PAGEREF _Toc100/);
  assert.match(linea, /w:fldCharType="begin"/);
  assert.match(linea, /w:fldCharType="end"/);
  assert.match(linea, /<w:t>3<\/w:t>/, 'el número de página no se toca');
  assert.match(linea, /CHAPTER I: PROBLEM AND OBJECTIVES/);
});

test('el índice no cuenta como trabajo hecho: es copia de los títulos', async () => {
  const buffer = docx(
    entrada('CAPÍTULO I: PROBLEMA Y OBJETIVOS', 3) +
      titulo('CAPÍTULO I: PROBLEMA Y OBJETIVOS') +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);

  assert.equal(hecho.tocados, 2, 'el título y el párrafo; la entrada del índice no');
  assert.equal(hecho.indice.entradas, 1);
  assert.equal(hecho.indice.sinPareja, 0);

  // Y tampoco se le cobra: al modelo no se le manda ninguna línea del índice.
  assert.deepEqual(hecho.parrafos.map((x) => x.texto), [
    'CAPÍTULO I: PROBLEMA Y OBJETIVOS',
    'El estudio parte de una necesidad concreta.',
  ]);
});

// ── Lo que no encaja se queda como está ────────────────────────────────────

test('una entrada sin título que le corresponda no se inventa', async () => {
  const buffer = docx(
    entrada('Anexo C: matriz de consistencia', 42) +
      titulo('CAPÍTULO I: PROBLEMA Y OBJETIVOS') +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);

  assert.match(xml, /Anexo C: matriz de consistencia/);
  assert.equal(hecho.indice.entradas, 1);
  assert.equal(hecho.indice.sinPareja, 1);
});

test('un índice escrito a mano, con los puntitos como texto, conserva sus puntos', async () => {
  const aMano =
    '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>' +
    t('Planteamiento del problema.........5') +
    '</w:p>';

  const buffer = docx(
    aMano + titulo('Planteamiento del problema') + p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);

  assert.match(xml, /Statement of the problem\.{9}5/);
});

test('el título partido en dos corridas se sustituye entero, sin duplicar', async () => {
  const partida =
    '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>' +
    '<w:hyperlink w:anchor="_Toc100" w:history="1">' +
    `<w:r><w:t xml:space="preserve">Planteamiento </w:t></w:r>${t('del problema')}` +
    '<w:r><w:tab/></w:r><w:r><w:t>5</w:t></w:r></w:hyperlink></w:p>';

  const buffer = docx(
    partida + titulo('Planteamiento del problema') + p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);

  assert.deepEqual(lineasDelIndice(xml), ['Statement of the problem\t5']);
  assert.doesNotMatch(xml, /Planteamiento/);
  assert.match(xml, /<w:t>5<\/w:t>/);
});

test('el número del capítulo se queda donde está, y el título se traduce', async () => {
  // Con la numeración automática de Word, el número lo pone la lista y no está
  // en el texto del título; en el índice sí. La entrada lo trae delante.
  const buffer = docx(
    entrada('1.1 Planteamiento del problema', 5) +
      titulo('Planteamiento del problema', 2) +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);

  assert.deepEqual(lineasDelIndice(xml), ['1.1 Statement of the problem\t5']);
  assert.equal(hecho.indice.sinPareja, 0);
});

// ── Los índices de tablas y de figuras ─────────────────────────────────────

test('la entrada del índice de tablas junta el rótulo traducido con su título', async () => {
  const buffer = docx(
    entrada('Tabla 1. Distribución de la muestra', 12) +
      p('Tabla 1') +
      p('Distribución de la muestra') +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, {
    ...DICCIONARIO,
    'Tabla 1': 'Table 1',
    'Distribución de la muestra': 'Sample distribution',
  });
  const xml = leerCuerpo(hecho.buffer);

  assert.match(xml, /Table 1\. Sample distribution/);
  assert.equal(hecho.indice.sinPareja, 0);
});

// ── Un índice sin estilo ───────────────────────────────────────────────────

/**
 * El 24-sep-2026: un Word guardado con Word en español traía las líneas del
 * índice SIN estilo —el archivo no declaraba TOC1 ni TOC2 y Word se los quitó—.
 * No se reconocieron, se mandaron a traducir como texto, fallaron las doce por
 * su campo y el índice se quedó en español. Se reconocen por el enlace `_Toc`.
 */
test('un índice sin estilo se reconoce por su enlace y se traduce igual', async () => {
  const sinEstilo = (texto, pagina, nivel = 1) => entrada(texto, pagina, nivel).replace(/<w:pStyle w:val="TOC\d"\/>/, '');
  const buffer = docx(
    p('Índice') +
      sinEstilo('CAPÍTULO I: PROBLEMA Y OBJETIVOS', 3) +
      sinEstilo('Planteamiento del problema', 3, 2) +
      titulo('CAPÍTULO I: PROBLEMA Y OBJETIVOS') +
      titulo('Planteamiento del problema', 2) +
      p('El estudio parte de una necesidad concreta.'),
  );

  const hecho = await traducirTodo(buffer, DICCIONARIO);
  const xml = leerCuerpo(hecho.buffer);

  // Al modelo no le llegan: solo el título «Índice», los dos títulos y el párrafo.
  assert.equal(hecho.parrafos.length, 4);
  assert.equal(hecho.intactos.size, 0);
  assert.deepEqual(hecho.indice, { entradas: 2, sinPareja: 0 });
  assert.doesNotMatch(xml, /PROBLEMA Y OBJETIVOS/);
  assert.doesNotMatch(xml, /Planteamiento del problema/);
  assert.match(xml, /PAGEREF _Toc100/, 'el número de página sigue siendo un campo');
});

test('una referencia cruzada normal (_Ref) no se toma por índice', async () => {
  const buffer = docx(
    '<w:p>' +
      t('Como se ve en la página ') +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> PAGEREF _Ref12345 \h </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      t('4') +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      t(', la muestra es pequeña.') +
      '</w:p>',
  );

  const { parrafos } = cuerpo.cuerpoDe(buffer, servicio.alcanceDe('TRADUCCION'));

  assert.equal(parrafos.length, 1, 'se manda a traducir como cualquier párrafo');
});
