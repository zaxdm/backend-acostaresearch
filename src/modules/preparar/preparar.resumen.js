'use strict';

/**
 * El Word con el resumen, el abstract y las palabras clave.
 *
 * POR QUÉ ES UN DOCUMENTO NUEVO Y NO EL SUYO CON EL RESUMEN PEGADO DELANTE
 * ------------------------------------------------------------------------
 * Los otros dos servicios devuelven el mismo documento que subió el cliente,
 * con sus tablas y su formato, porque lo que hacen es transformarlo. Este no lo
 * transforma: lee y escribe algo nuevo de una página.
 *
 * Meterlo dentro de su documento obligaría a adivinar dónde va, y en un .docx
 * ajeno eso es adivinar de verdad: delante de la portada, detrás de la portada,
 * antes o después del índice, sustituyendo el resumen que ya tuviera. Cualquiera
 * de las cuatro es la correcta en algún documento y un destrozo en los otros
 * tres. Y el destrozo sería sobre la portada, que es la página que más veces ha
 * rehecho el tesista.
 *
 * Así que se entrega aparte y él lo pega donde le toque según su reglamento,
 * que es lo que iba a hacer de todas formas. Su documento vuelve intacto.
 *
 * Formato sobrio y sin pretensiones de imitar ninguna plantilla, por lo mismo
 * que el Word de la tesis: Times New Roman 12, que es lo que pide casi
 * cualquier reglamento peruano, y los títulos marcados como títulos de verdad
 * para que al pegarlo tome el estilo de destino.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} = require('docx');

/** Interlineado sencillo. Un resumen va a un espacio, no a doble. */
const SENCILLO = 240;

const parrafo = (texto, extra = {}) =>
  new Paragraph({
    spacing: { line: SENCILLO, after: 200 },
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text: texto, font: 'Times New Roman', size: 24 })],
    ...extra,
  });

const titulo = (texto) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 160 },
    children: [new TextRun({ text: texto, font: 'Times New Roman', size: 28, bold: true })],
  });

/** Un párrafo de «Palabras clave: a; b; c», con el rótulo en cursiva. */
const clave = (rotulo, valor) =>
  new Paragraph({
    spacing: { line: SENCILLO, after: 200 },
    alignment: AlignmentType.JUSTIFIED,
    children: [
      new TextRun({ text: `${rotulo}: `, font: 'Times New Roman', size: 24, italics: true }),
      new TextRun({ text: valor, font: 'Times New Roman', size: 24 }),
    ],
  });

/**
 * El aviso de que esto lo escribió una IA.
 *
 * Va DENTRO del documento, no solo en la web. El archivo se reenvía, se sube a
 * un repositorio y acaba en manos de un asesor que no vio nunca nuestra página:
 * el aviso tiene que viajar con él. Es la misma razón por la que se entrega con
 * el aviso aunque el cliente ya lo haya leído tres veces al comprar.
 */
const AVISO =
  'Este texto lo redactó un sistema de inteligencia artificial a partir de tu documento. ' +
  'Revísalo y contrástalo con tu trabajo antes de usarlo: comprueba las cifras, ' +
  'que el objetivo sea el tuyo y que no falte nada importante. Tú firmas lo que entregas.';

/** El .docx con las cuatro piezas. `nombre` es el del documento del cliente. */
async function armar({ resumen, abstract, palabrasClave, keywords, nombre }) {
  const documento = new Document({
    creator: 'Acosta | IA & Research',
    title: `Resumen y abstract — ${nombre}`,
    description: 'Generado con inteligencia artificial. Requiere revisión del autor.',
    sections: [
      {
        children: [
          titulo('Resumen'),
          parrafo(resumen),
          clave('Palabras clave', palabrasClave),
          titulo('Abstract'),
          parrafo(abstract),
          clave('Keywords', keywords),
          new Paragraph({
            spacing: { before: 600, line: SENCILLO },
            children: [
              new TextRun({ text: AVISO, font: 'Times New Roman', size: 18, italics: true }),
            ],
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(documento);
}

module.exports = { armar, AVISO };
