'use strict';

/**
 * El comentario que abre el documento corregido.
 *
 * PARA QUÉ
 * --------
 * Word no siempre enseña las revisiones al abrir. Según cómo tenga el cliente
 * su «Revisar», el mismo archivo se ve con los tachados y los subrayados o se
 * ve limpio, como si no hubiéramos tocado nada —eso es «Marcas simples», y es
 * lo que trae Word de fábrica en muchas instalaciones—. Quien lo abre así cree
 * que el servicio no hizo nada y escribe para quejarse, con razón desde donde
 * él mira.
 *
 * Por eso el documento sale con un comentario al principio que dice dónde
 * mirar. Es lo que hacen las editoriales de corrección de verdad, y por eso se
 * hace igual.
 *
 * POR QUÉ UN COMENTARIO Y NO UN PÁRRAFO
 * -------------------------------------
 * Porque un párrafo de aviso metido arriba es texto DENTRO de su manuscrito:
 * se lo llevaría a la revista si se le olvida borrarlo. Un comentario no es el
 * documento, no se imprime y se quita con un clic derecho. Y aparece en el
 * mismo panel de revisiones donde están las correcciones, que es justo donde se
 * le quiere mandar.
 *
 * QUÉ HACE FALTA PARA QUE WORD LO ABRA
 * ------------------------------------
 * Un comentario de Word no es una etiqueta: son cuatro sitios que tienen que
 * cuadrar, y si falta uno el archivo no abre.
 *   1. `word/comments.xml`, con el texto.
 *   2. La relación en `word/_rels/document.xml.rels`, que apunta a ese archivo.
 *   3. El `Override` en `[Content_Types].xml`, que dice de qué tipo es.
 *   4. En `word/document.xml`, las marcas de dónde empieza y acaba, y la
 *      llamada que enseña el globito.
 *
 * Si el documento YA traía comentarios —del asesor del tesista, por ejemplo—,
 * los tres primeros ya están y solo se añade el nuestro, con un identificador
 * que no choque con los suyos. Los suyos no se tocan.
 */

const documento = require('../projects/project.documento');

const PARTE_COMENTARIOS = 'word/comments.xml';
const RELACIONES = 'word/_rels/document.xml.rels';
const TIPOS = '[Content_Types].xml';

const TIPO_COMENTARIOS =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const RELACION_COMENTARIOS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Quién firma el aviso, como sale en el panel de revisiones de Word. */
const AUTOR = 'Acosta | IA & Research';
const INICIALES = 'AR';

/**
 * Lo que se le dice, y en su idioma.
 *
 * En castellano aunque el manuscrito esté en inglés: el manuscrito es para la
 * revista y esto es para él. Y se repite aquí que lo hizo una IA, porque este
 * comentario es lo primero que ve al abrir el archivo.
 */
const AVISO = [
  'Tus correcciones están marcadas con el control de cambios de Word.',
  'Si abres el documento y no ves ninguna, entra en la pestaña «Revisar» y elige «Todas las ' +
    'revisiones» en el desplegable de arriba, junto a «Mostrar revisiones».',
  'Revisa una por una con «Anterior» y «Siguiente», y quédate con las que quieras usando ' +
    '«Aceptar» o «Rechazar». Puedes borrar este comentario cuando termines.',
  'Lo corrigió un sistema de inteligencia artificial y nadie lo revisó después: léelo antes de ' +
    'entregarlo o de enviarlo a una revista.',
];

/** La fecha como la escribe Word: sin milisegundos y con Z. */
const enIso = (fecha) => new Date(fecha).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── Los cuatro sitios ──────────────────────────────────────────────────────

/** El texto de una parte del zip, o null si no está. */
const leer = (zip, nombre) => zip.getEntry(nombre)?.getData().toString('utf8') ?? null;

const escribir = (zip, nombre, texto) => {
  if (zip.getEntry(nombre)) zip.updateFile(nombre, Buffer.from(texto, 'utf8'));
  else zip.addFile(nombre, Buffer.from(texto, 'utf8'));
};

/** El primer identificador de comentario que no use ya el documento. */
function siguienteId(comentariosXml) {
  const usados = [...String(comentariosXml ?? '').matchAll(/<w:comment\b[^>]*\sw:id="(\d+)"/g)].map(
    (encaje) => Number(encaje[1]),
  );
  return usados.length === 0 ? 1 : Math.max(...usados) + 1;
}

/** `word/comments.xml` con el nuestro añadido al final. */
function conElComentario(comentariosXml, { id, fecha, parrafos }) {
  const cuerpo = parrafos
    .map(
      (texto, n) =>
        '<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>' +
        // La llamada va en el primero: es lo que Word usa para enlazar el
        // globito con el texto señalado.
        (n === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : '') +
        `<w:r><w:t xml:space="preserve">${documento.escaparXml(texto)}</w:t></w:r></w:p>`,
    )
    .join('');

  const comentario =
    `<w:comment w:id="${id}" w:author="${documento.escaparXml(AUTOR)}" ` +
    `w:initials="${INICIALES}" w:date="${enIso(fecha)}">${cuerpo}</w:comment>`;

  if (!comentariosXml) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W}">${comentario}</w:comments>`;
  }

  // Un `<w:comments/>` vacío se abre antes de meterle nada dentro.
  const abierto = comentariosXml.replace(/<w:comments([^>]*?)\/>/, '<w:comments$1></w:comments>');
  return abierto.replace('</w:comments>', `${comentario}</w:comments>`);
}

/** Las relaciones con la de comentarios, si no la tenían ya. */
function conLaRelacion(relacionesXml) {
  if (relacionesXml && relacionesXml.includes(RELACION_COMENTARIOS)) return relacionesXml;

  const usados = [...String(relacionesXml ?? '').matchAll(/Id="rId(\d+)"/g)].map((e) => Number(e[1]));
  const id = `rId${usados.length === 0 ? 1 : Math.max(...usados) + 1}`;
  const relacion = `<Relationship Id="${id}" Type="${RELACION_COMENTARIOS}" Target="comments.xml"/>`;

  if (!relacionesXml) {
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `${relacion}</Relationships>`
    );
  }
  return relacionesXml.replace('</Relationships>', `${relacion}</Relationships>`);
}

/** Los tipos con el de comentarios, si no lo tenían ya. */
function conElTipo(tiposXml) {
  if (!tiposXml || tiposXml.includes(TIPO_COMENTARIOS)) return tiposXml;

  const override = `<Override PartName="/${PARTE_COMENTARIOS}" ContentType="${TIPO_COMENTARIOS}"/>`;
  const abierto = tiposXml.replace(/<Types([^>]*?)\/>/, '<Types$1></Types>');
  return abierto.replace('</Types>', `${override}</Types>`);
}

/**
 * El `document.xml` con el comentario colgado del primer párrafo con texto.
 *
 * Del primero con texto y no del `<w:body>`: un comentario tiene que señalar
 * algo, y lo que se señala aquí es el título del trabajo, que es lo primero que
 * el cliente ve al abrir.
 *
 * `<w:pPr>` tiene que seguir siendo el primer hijo del párrafo —Word no abre un
 * documento donde no lo sea—, así que las marcas entran detrás de él.
 */
function conLasMarcas(xml, id) {
  const primero = documento.parrafosDe(xml).find((parrafo) => parrafo.texto.trim() !== '');
  if (!primero) return null;

  const parrafo = xml.slice(primero.inicio, primero.fin);

  const apertura = parrafo.match(/^<w:p(?:\s[^>]*)?>/);
  if (!apertura) return null;

  const pPr = parrafo.slice(apertura[0].length).match(/^<w:pPr>[\s\S]*?<\/w:pPr>|^<w:pPr\s*\/>/);
  const hasta = apertura[0].length + (pPr ? pPr[0].length : 0);

  const marcado =
    parrafo.slice(0, hasta) +
    `<w:commentRangeStart w:id="${id}"/>` +
    parrafo.slice(hasta, parrafo.length - '</w:p>'.length) +
    `<w:commentRangeEnd w:id="${id}"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>` +
    '</w:p>';

  return xml.slice(0, primero.inicio) + marcado + xml.slice(primero.fin);
}

// ── Ponerlo ────────────────────────────────────────────────────────────────

/**
 * El mismo .docx con el comentario de aviso al principio.
 *
 * Devuelve el buffer tal cual si no hay dónde colgarlo —un documento sin un
 * solo párrafo con texto—: el aviso es una ayuda, y ninguna ayuda justifica
 * devolver un archivo que no abre.
 */
function poner(buffer, { fecha = new Date(), parrafos = AVISO } = {}) {
  const { zip, xml } = documento.abrir(buffer);

  const comentarios = leer(zip, PARTE_COMENTARIOS);
  const id = siguienteId(comentarios);

  const conMarcas = conLasMarcas(xml, id);
  if (!conMarcas) return buffer;

  escribir(zip, 'word/document.xml', conMarcas);
  escribir(zip, PARTE_COMENTARIOS, conElComentario(comentarios, { id, fecha, parrafos }));
  escribir(zip, RELACIONES, conLaRelacion(leer(zip, RELACIONES)));

  const tipos = conElTipo(leer(zip, TIPOS));
  if (tipos) escribir(zip, TIPOS, tipos);

  return zip.toBuffer();
}

module.exports = { poner, AVISO, AUTOR, siguienteId, conElComentario, conLaRelacion, conElTipo };
