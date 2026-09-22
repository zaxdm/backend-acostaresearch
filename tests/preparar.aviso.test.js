'use strict';

/**
 * El comentario que abre el documento corregido.
 *
 * POR QUÉ EXISTE
 * --------------
 * Porque el mismo .docx se ve de dos maneras según cómo tenga Word el cliente:
 * con los tachados y los subrayados a la vista, o limpio, como si no
 * hubiéramos tocado nada. Lo segundo es «Marcas simples», que es lo que trae
 * Word de fábrica en muchas instalaciones, y quien abre así cree que el
 * servicio no hizo su trabajo.
 *
 * LO QUE SE COMPRUEBA
 * -------------------
 * Un comentario de Word son cuatro sitios que tienen que cuadrar, y si falta
 * uno el archivo NO ABRE. Aquí se comprueban los cuatro, que el documento
 * siga leyéndose, que las revisiones no se toquen, y que un documento que ya
 * traía comentarios —los del asesor del tesista— los conserve.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const aviso = require('../src/modules/preparar/preparar.aviso');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const t = (texto) => `<w:r><w:t xml:space="preserve">${texto}</w:t></w:r>`;

function docx(cuerpo, extras = {}) {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(`<?xml version="1.0"?><Types xmlns="${REL}/content-types"></Types>`),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${cuerpo}</w:body></w:document>`),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));
  for (const [nombre, texto] of Object.entries(extras)) zip.addFile(nombre, Buffer.from(texto));
  return zip.toBuffer();
}

const parte = (buffer, nombre) => new AdmZip(buffer).getEntry(nombre)?.getData().toString('utf8') ?? null;

// ── Los cuatro sitios ──────────────────────────────────────────────────────

test('el comentario deja sus cuatro piezas, que es lo que Word exige para abrirlo', () => {
  const puesto = aviso.poner(docx(`<w:p>${t('From Musical Identity to Music Teacher Education')}</w:p>`));

  const comentarios = parte(puesto, 'word/comments.xml');
  assert.match(comentarios, /<w:comment\b[^>]*w:id="1"/);
  assert.match(comentarios, /control de cambios de Word/);
  assert.match(comentarios, /Todas las revisiones/);

  assert.match(parte(puesto, 'word/_rels/document.xml.rels'), /relationships\/comments/);
  assert.match(parte(puesto, '[Content_Types].xml'), /comments\+xml/);

  const texto = parte(puesto, 'word/document.xml');
  assert.match(texto, /<w:commentRangeStart w:id="1"\/>/);
  assert.match(texto, /<w:commentRangeEnd w:id="1"\/>/);
  assert.match(texto, /<w:commentReference w:id="1"\/>/);
});

test('el documento sigue leyéndose igual y no se le añade una palabra', () => {
  const antes = docx(`<w:p>${t('El título del trabajo')}</w:p><w:p>${t('Un párrafo.')}</w:p>`);
  const despues = aviso.poner(antes);

  assert.deepEqual(
    documento.leer(despues).map((p) => p.texto),
    documento.leer(antes).map((p) => p.texto),
  );
});

test('las correcciones marcadas no se tocan', () => {
  const conRevision =
    '<w:p>' +
    t('The results ') +
    '<w:ins w:id="900001" w:author="Acosta" w:date="2026-09-22T00:00:00Z">' +
    t('showed ') +
    '</w:ins>' +
    '<w:del w:id="900002" w:author="Acosta" w:date="2026-09-22T00:00:00Z">' +
    '<w:r><w:delText xml:space="preserve">shows </w:delText></w:r>' +
    '</w:del>' +
    t('an effect.') +
    '</w:p>';

  const texto = parte(aviso.poner(docx(conRevision)), 'word/document.xml');

  assert.equal((texto.match(/<w:ins[ >]/g) ?? []).length, 1);
  assert.equal((texto.match(/<w:del[ >]/g) ?? []).length, 1);
  assert.match(texto, /<w:delText xml:space="preserve">shows <\/w:delText>/);
});

// ── Donde se cuelga ────────────────────────────────────────────────────────

test('`w:pPr` sigue siendo el primer hijo del párrafo: si no, Word no abre', () => {
  const conEstilo = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${t('El título')}</w:p>`;
  const texto = parte(aviso.poner(docx(conEstilo)), 'word/document.xml');

  assert.match(texto, /<w:p><w:pPr><w:pStyle w:val="Title"\/><\/w:pPr><w:commentRangeStart/);
});

test('se cuelga del primer párrafo CON TEXTO, no de los vacíos de la portada', () => {
  const texto = parte(
    aviso.poner(docx(`<w:p/><w:p></w:p><w:p>${t('El título')}</w:p>`)),
    'word/document.xml',
  );

  const donde = texto.indexOf('<w:commentRangeStart');
  assert.ok(donde > texto.indexOf('El título') - 200, 'el comentario tiene que señalar al título');
  assert.match(texto.slice(donde, donde + 220), /El título/);
});

test('un documento sin una sola palabra se devuelve tal cual, no roto', () => {
  const vacio = docx('<w:p/>');
  assert.equal(aviso.poner(vacio), vacio);
});

// ── Con comentarios del asesor ya dentro ───────────────────────────────────

test('los comentarios que ya traía el documento se conservan, y el nuestro no choca', () => {
  const suyos =
    `<?xml version="1.0"?><w:comments xmlns:w="${W}">` +
    `<w:comment w:id="0" w:author="Asesor" w:date="2026-09-01T10:00:00Z"><w:p>${t('Revisa esta cita.')}</w:p></w:comment>` +
    `<w:comment w:id="7" w:author="Asesor" w:date="2026-09-01T10:05:00Z"><w:p>${t('Falta el año.')}</w:p></w:comment>` +
    '</w:comments>';

  const relaciones =
    `<?xml version="1.0"?><Relationships xmlns="${REL}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' +
    '</Relationships>';

  const puesto = aviso.poner(
    docx(`<w:p>${t('El título')}</w:p>`, {
      'word/comments.xml': suyos,
      'word/_rels/document.xml.rels': relaciones,
    }),
  );

  const comentarios = parte(puesto, 'word/comments.xml');
  assert.match(comentarios, /Revisa esta cita\./);
  assert.match(comentarios, /Falta el año\./);

  // El siguiente libre es el 8, no el 0 ni el 7: dos comentarios con el mismo
  // identificador dejan el documento sin abrir.
  assert.match(comentarios, /<w:comment\b[^>]*w:id="8"/);
  assert.match(parte(puesto, 'word/document.xml'), /<w:commentReference w:id="8"\/>/);

  // Y la relación no se duplica.
  assert.equal((parte(puesto, 'word/_rels/document.xml.rels').match(/relationships\/comments/g) ?? []).length, 1);
});

test('el siguiente identificador libre se saca de los que ya hay', () => {
  assert.equal(aviso.siguienteId(null), 1);
  assert.equal(aviso.siguienteId('<w:comments/>'), 1);
  assert.equal(aviso.siguienteId('<w:comments><w:comment w:id="0"/><w:comment w:id="12"/></w:comments>'), 13);
});
