'use strict';

/**
 * Las partes del .docx que llevan prosa, y no solo `word/document.xml`.
 *
 * POR QUÉ
 * -------
 * Un .docx no es un archivo: es un zip con una docena. El texto del cuerpo está
 * en `word/document.xml`, pero las notas al pie viven en `word/footnotes.xml`,
 * las notas al final en `word/endnotes.xml`, y el título que se repite arriba de
 * cada página y el pie con el nombre del autor en sus propios
 * `word/header1.xml` y `word/footer1.xml`.
 *
 * Mientras esto solo miró `document.xml`, una traducción devolvía el cuerpo en
 * inglés y el pie de página en español, y una nota al pie de media página se
 * quedaba entera como estaba sin que nadie lo dijera. Para el cliente eso es un
 * documento a medio traducir, y tiene razón.
 *
 * QUÉ NO ESTÁ AQUÍ
 * ----------------
 * · Los comentarios (`word/comments.xml`). Son conversación entre el autor y su
 *   asesor sobre el borrador, no el documento: traducirlos cambiaría lo que
 *   dijo una persona.
 * · Todo lo demás del zip: estilos, numeración, fuentes, imágenes. Ahí no hay
 *   prosa.
 *
 * LA CLAVE
 * --------
 * Cada párrafo necesita un nombre único en TODO el documento, porque el modelo
 * recibe los de todas las partes juntos y devuelve un JSON con esas claves. En
 * `document.xml` la clave sigue siendo el número de siempre —«17»—, que es lo
 * que ya usan la edición y el conector; en las demás lleva delante de dónde
 * sale: «nota:3», «pie1:2». Así una clave dice siempre a qué archivo del zip
 * hay que volver a escribirla.
 */

const documento = require('../projects/project.documento');

/** Donde está el cuerpo. Sus párrafos conservan la clave numérica de siempre. */
const PRINCIPAL = 'word/document.xml';

/** De dónde sale cada parte, en las palabras que se le pueden enseñar al cliente. */
const DE_DONDE = Object.freeze({
  [PRINCIPAL]: 'el cuerpo del documento',
  'word/footnotes.xml': 'las notas al pie',
  'word/endnotes.xml': 'las notas al final',
});

/** El nombre corto con el que empieza la clave de cada parte. */
function etiquetaDe(parte) {
  if (parte === 'word/footnotes.xml') return 'nota';
  if (parte === 'word/endnotes.xml') return 'final';
  const encabezado = parte.match(/^word\/header(\d*)\.xml$/);
  if (encabezado) return `enc${encabezado[1] || '1'}`;
  const pie = parte.match(/^word\/footer(\d*)\.xml$/);
  if (pie) return `pie${pie[1] || '1'}`;
  return null;
}

/** «el encabezado», «el pie de página», para decirle al cliente dónde quedó algo. */
function donde(parte) {
  if (DE_DONDE[parte]) return DE_DONDE[parte];
  if (/^word\/header\d*\.xml$/.test(parte)) return 'el encabezado';
  if (/^word\/footer\d*\.xml$/.test(parte)) return 'el pie de página';
  return 'el documento';
}

/**
 * Las partes con prosa que hay en este zip, aparte del cuerpo.
 *
 * En orden y sin repetir, para que el número de párrafo de un documento no
 * cambie entre la vez que se cuenta y la vez que se escribe.
 */
function otrasPartesDe(zip) {
  return zip
    .getEntries()
    .map((entrada) => entrada.entryName)
    .filter((nombre) => etiquetaDe(nombre) !== null)
    .sort();
}

/**
 * El texto de una nota al pie o al final que no es una nota: los separadores.
 *
 * Word guarda en `footnotes.xml` dos notas de mentira —la rayita que separa las
 * notas del texto y la que se usa cuando una nota continúa en la página
 * siguiente— y no llevan texto, así que se van solas al filtrar por palabras.
 * Se nombran aquí para que quede dicho por qué no aparecen.
 */
const SEPARADORES = /w:type="(separator|continuationSeparator)"/;

/**
 * Los párrafos de las partes que no son el cuerpo, con su clave y de dónde
 * salen.
 *
 * `palabrasDe` llega de fuera —lo define `preparar.cuerpo`— para que la cuenta
 * de palabras sea UNA en todo el módulo: la que se le enseña al cliente es la
 * misma que decide qué se le manda al modelo.
 */
function parrafosDeOtrasPartes(zip, palabrasDe) {
  const parrafos = [];

  for (const parte of otrasPartesDe(zip)) {
    const xml = zip.getEntry(parte).getData().toString('utf8');
    if (!xml.includes('<w:p')) continue;

    const etiqueta = etiquetaDe(parte);
    for (const parrafo of documento.parrafosDe(xml)) {
      const palabras = palabrasDe(parrafo.texto);
      if (palabras === 0) continue;
      parrafos.push({
        clave: `${etiqueta}:${parrafo.id}`,
        parte,
        id: parrafo.id,
        texto: parrafo.texto,
        nivel: null,
        palabras,
      });
    }
  }

  return parrafos;
}

module.exports = {
  PRINCIPAL,
  etiquetaDe,
  donde,
  otrasPartesDe,
  parrafosDeOtrasPartes,
  SEPARADORES,
};
