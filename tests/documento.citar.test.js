'use strict';

/**
 * Citar el Word que subió el tesista, sin tocar nada más.
 *
 * Los documentos se arman aquí a mano, con lo que hace difícil la vida a quien
 * edita un .docx por dentro: palabras partidas en varias corridas, entidades,
 * negritas, un cuadro de texto con su copia antigua, una tabla y un título de
 * «Referencias» esperando. Se abre el resultado y se lee su XML.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

const ESTILOS =
  `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}">` +
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="TDC1"><w:name w:val="toc 1"/></w:style>' +
  '</w:styles>';

const SECCION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';

function docx(cuerpo) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:mc="${MC}">` +
        `<w:body>${cuerpo}${SECCION}</w:body></w:document>`,
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(ESTILOS));
  zip.addFile('word/media/figura.png', Buffer.from('no-es-una-imagen-pero-tiene-que-seguir-igual'));
  return zip.toBuffer();
}

const p = (...corridas) => `<w:p>${corridas.join('')}</w:p>`;
const r = (texto, rPr = '') => `<w:r>${rPr}<w:t>${texto}</w:t></w:r>`;
const titulo = (texto) => `<w:p><w:pPr><w:pStyle w:val="Ttulo1"/></w:pPr>${r(texto)}</w:p>`;

const FUENTES = [
  {
    ref: 'AR11111111',
    itemType: 'journalArticle',
    title: 'Disentangling behavioral intention and behavioral expectation',
    authors: 'Warshaw, P. R.; Davis, F. D.',
    year: 1985,
    source: 'Journal of Experimental Social Psychology',
    volume: '21',
    issue: '3',
    pages: '213-228',
  },
  {
    ref: 'AR22222222',
    itemType: 'journalArticle',
    title: 'Using thematic analysis in psychology',
    authors: 'Braun, V.; Clarke, V.',
    year: 2006,
    source: 'Qualitative Research in Psychology',
    volume: '3',
    issue: '2',
    pages: '77-101',
  },
];
const porClave = new Map(FUENTES.map((f) => [f.ref, f]));

const CUERPO =
  titulo('Capítulo I') +
  '<w:p/>' +
  // «académico» partido en dos corridas, la primera con formato propio.
  p(
    r('El rendimiento acad', '<w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:sz w:val="24"/></w:rPr>'),
    r('émico depende de la motivación.'),
  ) +
  p(r('Braun y Clarke proponen seis fases de R&amp;D.')) +
  '<w:tbl><w:tr><w:tc>' + p(r('Una celda sin cita.')) + '</w:tc></w:tr></w:tbl>' +
  // Un cuadro de texto: el texto está en la opción nueva y en la copia antigua.
  p(
    '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>' +
      p(r('Texto del cuadro.')) +
      '</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>' +
      p(r('Texto del cuadro.')) +
      '</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>',
  ) +
  `<w:p><w:pPr><w:pStyle w:val="TDC1"/></w:pPr>${r('Capítulo I')}<w:r><w:tab/></w:r>${r('3')}</w:p>`;

const parte = (buffer) => new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');

/** El texto visible de cada párrafo del Word resultante, para leerlo como lo leería el tesista. */
const textos = (buffer) => documento.parrafosDe(parte(buffer)).map((x) => x.texto).filter(Boolean);

function equilibrado(xml, etiqueta) {
  const abre = [...xml.matchAll(new RegExp(`<${etiqueta}[ >]`, 'g'))].length;
  const cierra = [...xml.matchAll(new RegExp(`</${etiqueta}>`, 'g'))].length;
  return abre === cierra;
}

// ── Leer ───────────────────────────────────────────────────────────────────

test('lee los párrafos con texto, une las corridas y deja fuera el índice y la copia antigua', () => {
  const leidos = documento.leer(docx(CUERPO));
  const lista = leidos.map((x) => x.texto);

  assert.deepEqual(lista, [
    'Capítulo I',
    'El rendimiento académico depende de la motivación.',
    'Braun y Clarke proponen seis fases de R&D.',
    'Una celda sin cita.',
    'Texto del cuadro.',
  ]);
  assert.equal(leidos[0].nivel, 1);
  assert.equal(leidos[3].enTabla, true);
  // El vacío cuenta para el identificador: el Word no cambia, el número tampoco.
  assert.equal(leidos[1].id, 3);
});

test('rechaza lo que no es un .docx con un mensaje para el tesista', () => {
  assert.throws(() => documento.leer(Buffer.from('%PDF-1.7')), documento.DocumentoNoValido);
  assert.throws(() => documento.leer(Buffer.alloc(0)), /vacío/);
});

// ── Comprobar ──────────────────────────────────────────────────────────────

test('acepta el párrafo con marcas aunque cambien los espacios o las comillas', () => {
  assert.equal(
    documento.comprobar('Según «Tinto», la deserción  crece.', 'Según "Tinto" [AR11111111], la deserción crece [FALTA FUENTE].'),
    null,
  );
});

test('rechaza el párrafo si Claude cambió una palabra, y dice dónde', () => {
  const motivo = documento.comprobar('La deserción crece cada año.', 'La deserción aumenta cada año [AR11111111].');
  assert.match(motivo, /no es el del Word/);
  assert.match(motivo, /crece/);
});

// ── Citar ──────────────────────────────────────────────────────────────────

test('APA: pone la cita en su sitio, la narrativa sin repetir autores, y la lista al final', () => {
  const salida = documento.citar(docx(CUERPO), {
    norma: 'apa',
    idioma: 'es-ES',
    porClave,
    citados: {
      3: 'El rendimiento académico depende de la motivación [AR11111111].',
      4: 'Braun y Clarke [AR22222222:n] proponen seis fases de R&D.',
    },
  });

  const lista = textos(salida.buffer);
  assert.ok(lista.includes('El rendimiento académico depende de la motivación (Warshaw & Davis, 1985).'), lista.join('\n'));
  assert.ok(lista.includes('Braun y Clarke (2006) proponen seis fases de R&D.'), lista.join('\n'));
  assert.ok(lista.includes('Referencias'));
  assert.ok(lista.some((t) => t.startsWith('Braun, V., & Clarke, V. (2006)')), lista.join('\n'));

  assert.equal(salida.citas, 2);
  assert.equal(salida.referencias, 2);

  const xml = parte(salida.buffer);
  // La sección final sigue siendo lo último del cuerpo, o Word pierde los márgenes.
  assert.ok(xml.endsWith(`${SECCION}</w:body></w:document>`));
  for (const etiqueta of ['w:p', 'w:r', 'w:t', 'w:rPr', 'w:tbl']) assert.ok(equilibrado(xml, etiqueta), etiqueta);
  // El título de la lista, en su estilo de Título 1 y sin numerar.
  assert.match(xml, /<w:pStyle w:val="Ttulo1"\/><w:pageBreakBefore\/><w:numPr>/);
});

test('la cita toma la letra de su frase pero no su negrita, y el texto partido conserva sus espacios', () => {
  const cuerpo = p(r('Crece la deserción ', '<w:rPr><w:rFonts w:ascii="Arial"/><w:b/><w:sz w:val="24"/></w:rPr>'), r('universitaria.'));
  const salida = documento.citar(docx(cuerpo), {
    norma: 'apa',
    porClave,
    citados: { 1: 'Crece la deserción [AR11111111] universitaria.' },
  });

  assert.deepEqual(textos(salida.buffer).slice(0, 1), ['Crece la deserción (Warshaw & Davis, 1985) universitaria.']);
  const xml = parte(salida.buffer);
  assert.match(xml, /<w:r><w:rPr><w:rFonts w:ascii="Arial"\/><w:sz w:val="24"\/><\/w:rPr><w:t xml:space="preserve">\(Warshaw/);
});

test('partir un texto sin xml:space le pone preserve, para que no se coma el espacio', () => {
  const salida = documento.citar(docx(p(r('Uno dos tres.'))), {
    norma: 'apa',
    porClave,
    citados: { 1: 'Uno dos [AR11111111] tres.' },
  });
  assert.deepEqual(textos(salida.buffer).slice(0, 1), ['Uno dos (Warshaw & Davis, 1985) tres.']);
  assert.ok(!parte(salida.buffer).includes('<w:t>Uno'));
});

test('IEEE: numera por orden de lectura aunque los párrafos lleguen desordenados', () => {
  const cuerpo = p(r('Primero.')) + p(r('Segundo.'));
  const salida = documento.citar(docx(cuerpo), {
    norma: 'ieee',
    porClave,
    citados: { 2: 'Segundo [AR11111111].', 1: 'Primero [AR22222222].' },
  });
  const lista = textos(salida.buffer);
  assert.equal(lista[0], 'Primero [1].');
  assert.equal(lista[1], 'Segundo [2].');
});

test('[FALTA FUENTE] sale resaltado y, sin citas, no hay lista de referencias', () => {
  const salida = documento.citar(docx(p(r('Una afirmación sin respaldo.'))), {
    norma: 'apa',
    porClave,
    citados: { 1: 'Una afirmación sin respaldo [FALTA FUENTE].' },
  });
  assert.equal(textos(salida.buffer)[0], 'Una afirmación sin respaldo [falta fuente].');
  assert.match(parte(salida.buffer), /<w:highlight w:val="yellow"\/>/);
  assert.equal(salida.faltas, 1);
  assert.ok(!textos(salida.buffer).includes('Referencias'));
});

test('si ya dejó el título «REFERENCIAS», la lista va debajo y no se repite el título', () => {
  const cuerpo = p(r('Una idea.')) + titulo('REFERENCIAS') + titulo('ANEXOS');
  const salida = documento.citar(docx(cuerpo), {
    norma: 'apa',
    porClave,
    citados: { 1: 'Una idea [AR11111111].' },
  });
  const lista = textos(salida.buffer);
  const donde = lista.indexOf('REFERENCIAS');
  assert.ok(lista[donde + 1].startsWith('Warshaw, P. R.'), lista.join('\n'));
  assert.equal(lista[donde + 2], 'ANEXOS');
  assert.ok(!lista.includes('Referencias'));
});

test('un párrafo que ya no coincide con el Word se salta en vez de citar otra frase', () => {
  const salida = documento.citar(docx(p(r('Texto nuevo del tesista.'))), {
    norma: 'apa',
    porClave,
    citados: { 1: 'Texto viejo [AR11111111].' },
  });
  assert.equal(salida.citas, 0);
  assert.equal(textos(salida.buffer)[0], 'Texto nuevo del tesista.');
});

test('todo lo demás del archivo sale igual', () => {
  const entrada = docx(CUERPO);
  const salida = documento.citar(entrada, { norma: 'apa', porClave, citados: { 3: 'El rendimiento académico depende de la motivación [AR11111111].' } });
  const antes = new AdmZip(entrada);
  const despues = new AdmZip(salida.buffer);
  for (const nombre of ['word/styles.xml', 'word/media/figura.png', '[Content_Types].xml']) {
    assert.ok(antes.getEntry(nombre).getData().equals(despues.getEntry(nombre).getData()), nombre);
  }
  // El cuadro de texto y su copia antigua, intactos.
  assert.equal([...parte(salida.buffer).matchAll(/Texto del cuadro\./g)].length, 2);
});

test('las normas de notas al pie se rechazan con un motivo que se le puede decir', () => {
  assert.throws(
    () => documento.citar(docx(p(r('Uno.'))), { norma: 'chicago-notes-bibliography', porClave, citados: { 1: 'Uno [AR11111111].' } }),
    documento.NormaConNotas,
  );
});

// ── Volver a subir ─────────────────────────────────────────────────────────

test('al subir otra versión, las citas siguen a su párrafo aunque cambie el número', () => {
  const nuevos = documento.leer(docx(p(r('Un párrafo añadido.')) + p(r('Uno.')) + p(r('Dos.'))));
  const { citados, perdidos } = documento.reubicar(
    { 1: 'Uno [AR11111111].', 2: 'Dos [AR22222222].', 3: 'Borrado [AR11111111].' },
    nuevos,
  );
  assert.deepEqual(citados, { 2: 'Uno [AR11111111].', 3: 'Dos [AR22222222].' });
  assert.equal(perdidos, 1);
});
