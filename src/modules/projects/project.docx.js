'use strict';

/**
 * El Word de la tesis.
 *
 * Un solo documento acumulativo, que es la regla del método desde antes de que
 * existiera esta plataforma: el tesista trabaja siempre sobre el mismo archivo y
 * lo va versionando. Hasta ahora eso lo sostenía él a mano, copiando y pegando
 * capítulo por capítulo y cuidando de que las versiones no se contradijeran.
 *
 * SOBRE EL FORMATO
 * ----------------
 * Va en Times New Roman 12, interlineado doble y sangría de primera línea:
 * es lo que pide casi cualquier reglamento de tesis peruano y lo que menos
 * trabajo le deja al tesista cuando pegue esto en la plantilla de su
 * universidad. No se intenta imitar ninguna plantilla concreta —cada
 * universidad tiene la suya y adivinar mal es peor que no intentarlo—: lo que
 * se entrega es el contenido bien estructurado, con los títulos marcados como
 * títulos de verdad, para que al aplicar la plantilla se coloque solo.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageNumber,
  Footer,
  TableOfContents,
  StyleLevel,
} = require('docx');

/** Interlineado doble, en las unidades de OOXML (240 = sencillo). */
const DOBLE = 480;
/** Sangría de primera línea: media pulgada, en twips. */
const SANGRIA = 720;

/**
 * Convierte el texto del capítulo en párrafos.
 *
 * El asistente escribe en Markdown porque es lo que sabe escribir, así que se
 * reconocen los encabezados y poco más. No se monta un analizador completo a
 * propósito: cuanto más se interpreta, más formas hay de estropear el texto de
 * alguien, y aquí el original es lo único que no se puede rehacer.
 */
function comoParrafos(texto) {
  const parrafos = [];

  for (const bruto of texto.split(/\n{2,}/)) {
    const bloque = bruto.trim();
    if (bloque === '') continue;

    const encabezado = bloque.match(/^(#{1,4})\s+(.*)$/);
    if (encabezado) {
      const nivel = encabezado[1].length;
      parrafos.push(
        new Paragraph({
          text: encabezado[2].trim(),
          heading:
            nivel === 1
              ? HeadingLevel.HEADING_2
              : nivel === 2
                ? HeadingLevel.HEADING_3
                : HeadingLevel.HEADING_4,
          spacing: { before: 240, after: 120 },
        }),
      );
      continue;
    }

    // Las listas se respetan como líneas sueltas sin sangría de primera línea.
    // Sangrar la primera línea de una viñeta la desalinea de las siguientes.
    const esLista = /^\s*([-*•]|\d+[.)])\s+/.test(bloque);

    for (const linea of bloque.split('\n')) {
      const contenido = linea.trim();
      if (contenido === '') continue;

      parrafos.push(
        new Paragraph({
          children: [new TextRun(contenido.replace(/^\s*[-*•]\s+/, '• '))],
          alignment: esLista ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
          spacing: { line: DOBLE },
          indent: esLista ? { left: SANGRIA } : { firstLine: SANGRIA },
        }),
      );
    }
  }

  return parrafos;
}

/** La portada: lo poco que el servidor sabe con certeza. */
function portada({ tema, carrera, universidad, nombre }) {
  const centrado = (texto, opciones = {}) =>
    new Paragraph({
      children: [new TextRun({ text: texto, ...opciones })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    });

  const hojas = [];
  if (universidad) hojas.push(centrado(universidad.toUpperCase(), { bold: true, size: 28 }));
  if (carrera) hojas.push(centrado(carrera, { size: 24 }));
  hojas.push(new Paragraph({ text: '', spacing: { after: 720 } }));
  hojas.push(centrado(tema ?? 'Tesis', { bold: true, size: 32 }));
  hojas.push(new Paragraph({ text: '', spacing: { after: 720 } }));
  if (nombre) hojas.push(centrado(nombre, { size: 24 }));

  return hojas;
}

/**
 * Arma el documento.
 *
 * `capitulos` llega en el orden del método y solo con los que tienen texto: un
 * índice con capítulos vacíos haría creer que el documento está más avanzado de
 * lo que está.
 */
async function armar({ tema, carrera, universidad, nombre, capitulos }) {
  const cuerpo = [
    ...portada({ tema, carrera, universidad, nombre }),
    new Paragraph({ text: '', pageBreakBefore: true }),
    new Paragraph({ text: 'Índice', heading: HeadingLevel.HEADING_1 }),
    // Word lo rellena al abrir el documento y pedir «actualizar campos». No se
    // puede calcular aquí: los números de página los decide Word al maquetar,
    // no nosotros.
    new TableOfContents('Índice', {
      hyperlink: true,
      headingStyleRange: '1-3',
      stylesWithLevels: [new StyleLevel('Heading1', 1), new StyleLevel('Heading2', 2)],
    }),
  ];

  for (const capitulo of capitulos) {
    cuerpo.push(
      new Paragraph({
        text: capitulo.titulo,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { after: 240 },
      }),
      ...comoParrafos(capitulo.texto),
    );
  }

  const documento = new Document({
    creator: 'Acosta | IA & Research',
    title: tema ?? 'Tesis',
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
        heading1: {
          run: { font: 'Times New Roman', size: 28, bold: true, color: '000000' },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240 } },
        },
        heading2: {
          run: { font: 'Times New Roman', size: 24, bold: true, color: '000000' },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading3: {
          run: { font: 'Times New Roman', size: 24, bold: true, italics: true, color: '000000' },
          paragraph: { spacing: { before: 200, after: 120 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            // Márgenes de tesis: 3 cm arriba, izquierda y abajo; 2,5 a la
            // derecha. En twips, que es lo que entiende Word.
            margin: { top: 1701, right: 1417, bottom: 1701, left: 1701 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT], size: 20 })],
              }),
            ],
          }),
        },
        children: cuerpo,
      },
    ],
  });

  return Packer.toBuffer(documento);
}

/**
 * Nombre del archivo que descarga el tesista.
 *
 * Lleva la fecha porque el método pide versionar —V1, V2, V3— y con quince
 * archivos llamados «tesis.docx» en la carpeta de descargas nadie sabe cuál es
 * el bueno.
 */
function nombreDeArchivo(tema) {
  const base = (tema ?? 'tesis')
    .normalize('NFD')
    // El rango de las tildes, escrito con códigos y no con los signos: escritos
    // tal cual son invisibles en el editor y cualquiera los borra sin verlos.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  const fecha = new Date().toISOString().slice(0, 10);
  return `${base || 'tesis'}-${fecha}.docx`;
}

module.exports = { armar, nombreDeArchivo, comoParrafos };
