'use strict';

/**
 * Los pendientes del texto, sacados al margen como comentarios de Word.
 *
 * Las skills dejan marcado lo que falta con «[PENDIENTE — …]», y hasta ahora
 * eso salía impreso dentro de la frase: el capítulo se leía con la nota de
 * trabajo metida en medio, y quien imprimía sin repasar la entregaba así. Lo
 * que se comprueba aquí es que la explicación se va al margen, que en el cuerpo
 * queda una marca corta y visible, y que un Word sin pendientes no cambia en
 * nada respecto a como salía antes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.docx');

async function wordDe(texto) {
  const buffer = await documento.armar({
    tema: 'Tema',
    nombre: 'Alguien',
    capitulos: [{ titulo: 'Capítulo I', texto }],
  });
  const zip = new AdmZip(buffer);
  return {
    cuerpo: zip.getEntry('word/document.xml').getData().toString('utf8'),
    // La librería escribe siempre `comments.xml`, vacío si no hay ninguno: lo
    // que dice si hay comentarios de verdad es que traiga algún <w:comment>.
    comentarios: zip.getEntry('word/comments.xml')?.getData().toString('utf8') ?? '',
    relaciones: zip.getEntry('word/_rels/document.xml.rels')?.getData().toString('utf8') ?? '',
  };
}

/** El texto de cada <w:t>, en orden. */
const textos = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);

test('un pendiente con detalle deja la explicación en el margen y una marca en el cuerpo', async () => {
  const { cuerpo, comentarios, relaciones } = await wordDe(
    'El diseño fue no experimental [PENDIENTE — confirmar el año de la ordenanza] y transversal.',
  );

  assert.match(comentarios, /<w:comment /, 'el documento lleva comentarios');
  assert.match(comentarios, /Pendiente: confirmar el año de la ordenanza/);
  // Sin la relación y sin el tipo de contenido, Word abre el archivo sin los
  // comentarios y no avisa de nada: el pendiente desaparecería.
  assert.match(relaciones, /comments\.xml/);

  // En el cuerpo queda el ancla, no la explicación.
  assert.ok(textos(cuerpo).includes('[PENDIENTE]'));
  assert.ok(
    !textos(cuerpo).some((t) => t.includes('confirmar el año')),
    'la explicación no se queda dentro de la frase',
  );
  assert.match(cuerpo, /<w:commentRangeStart w:id="0"\/>/);
  assert.match(cuerpo, /<w:commentRangeEnd w:id="0"\/>/);
  assert.match(cuerpo, /<w:commentReference w:id="0"\/>/);
  // Resaltado: un comentario solo se ve con el panel abierto.
  assert.match(cuerpo, /<w:highlight w:val="yellow"\/>(?:[^<]|<(?!\/w:r>))*\[PENDIENTE\]/);

  // Y la frase sigue entera alrededor del pendiente.
  assert.ok(textos(cuerpo).some((t) => t.includes('El diseño fue no experimental')));
  assert.ok(textos(cuerpo).some((t) => t.includes('y transversal.')));
});

test('un pendiente sin detalle también sale, con su texto por defecto', async () => {
  const { comentarios } = await wordDe('Faltan los datos [PENDIENTE].');
  assert.match(comentarios, /Pendiente de completar\./);
});

test('cada pendiente lleva su propio comentario, y se numeran en orden', async () => {
  const { cuerpo, comentarios } = await wordDe(
    'Uno [PENDIENTE — el primero].\n\nDos [PENDIENTE: el segundo].\n\nTres [PENDIENTE - el tercero].',
  );

  assert.deepEqual(
    [...comentarios.matchAll(/w:id="(\d+)"/g)].map((m) => m[1]),
    ['0', '1', '2'],
  );
  assert.match(comentarios, /Pendiente: el primero/);
  assert.match(comentarios, /Pendiente: el segundo/);
  assert.match(comentarios, /Pendiente: el tercero/);
  assert.equal([...cuerpo.matchAll(/<w:commentReference /g)].length, 3);
});

test('un pendiente dentro de una celda de tabla también va al margen', async () => {
  const { cuerpo, comentarios } = await wordDe(
    '**Tabla 1**\n| Variable | Instrumento |\n|---|---|\n| Clima | [PENDIENTE — falta la ficha técnica] |',
  );

  assert.match(comentarios, /Pendiente: falta la ficha técnica/);
  // Dentro de la tabla, no detrás de ella.
  const tabla = cuerpo.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)[0];
  assert.match(tabla, /<w:commentReference w:id="0"\/>/);
});

test('un Word sin pendientes no lleva comentarios', async () => {
  const { cuerpo, comentarios } = await wordDe('Un capítulo normal, sin nada que completar.');
  assert.doesNotMatch(comentarios, /<w:comment /);
  assert.ok(!cuerpo.includes('commentReference'));
});

test('la palabra «pendiente» en una frase no es un pendiente', async () => {
  const { comentarios, cuerpo } = await wordDe('El trámite sigue pendiente en la facultad.');
  assert.doesNotMatch(comentarios, /<w:comment /);
  assert.ok(textos(cuerpo).some((t) => t.includes('sigue pendiente en la facultad')));
});

test('«[FALTA FUENTE]» sale en amarillo, dentro de la frase', async () => {
  // Es la marca más frecuente del método con diferencia, y salía como texto
  // normal: el mismo color que la tesis, en medio de un párrafo. El tesista se
  // la llevaba impresa al jurado sin haberla visto.
  const { cuerpo, comentarios } = await wordDe(
    'En las Américas la proporción alcanza el 97 % [FALTA FUENTE]. Y sigue.',
  );

  const marca = cuerpo.match(
    /<w:r>(?:(?!<\/w:r>)[\s\S])*FALTA FUENTE(?:(?!<\/w:r>)[\s\S])*<\/w:r>/,
  )[0];
  assert.match(marca, /<w:highlight w:val="yellow"\/>/);
  // Corta como es, se queda en el párrafo: no hay nada que explicar al margen.
  assert.ok(!comentarios.includes('Pendiente: '), 'no se saca al margen: ya es corta');
});

test('«[DATO PENDIENTE: …]» deja su explicación al margen y su marca amarilla', async () => {
  const { cuerpo, comentarios } = await wordDe(
    'No hay institución definida. [DATO PENDIENTE: observaciones de campo, a completar antes de la sustentación]',
  );

  const marca = cuerpo.match(
    /<w:r>(?:(?!<\/w:r>)[\s\S])*DATO PENDIENTE(?:(?!<\/w:r>)[\s\S])*<\/w:r>/,
  )[0];
  assert.match(marca, /<w:highlight w:val="yellow"\/>/);
  assert.match(marca, /\[DATO PENDIENTE\]/, 'en el cuerpo, la marca corta');
  assert.match(comentarios, /Pendiente: observaciones de campo/, 'la explicación, al margen');
  assert.ok(!cuerpo.includes('observaciones de campo'), 'y no dentro del párrafo');
});

test('«[A DEFINIR EN CAP III]» también se ve: es lo que la matriz deja abierto', async () => {
  // La matriz de consistencia sale con estas en la columna de metodología,
  // porque el tipo, el diseño y el análisis se deciden en el Capítulo III.
  const { cuerpo } = await wordDe('Tipo: [A DEFINIR EN CAP III]. Nivel: descriptivo.');

  const marca = cuerpo.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*A DEFINIR(?:(?!<\/w:r>)[\s\S])*<\/w:r>/)[0];
  assert.match(marca, /<w:highlight w:val="yellow"\/>/);
});
