'use strict';

/**
 * El informe en Word del análisis que hizo Claude con los datos del tesista.
 *
 * Es el Capítulo IV que el tesista le lleva a su asesor: tablas en formato APA,
 * las figuras que dibujó R en su sesión, la interpretación, y las citas y la
 * lista de referencias en la norma que elija. Claude escribe el contenido; aquí
 * solo se maqueta.
 *
 * NO ES OTRO WORD
 * ---------------
 * Se reutiliza lo del Word de la tesis (`project.docx`): el mismo Markdown, las
 * mismas tablas APA, las mismas citas por clave y la misma lista de
 * referencias. Un tesista que pega este informe dentro de su tesis tiene que
 * ver el mismo formato, no uno parecido. Lo único propio del informe son las
 * figuras, que el Word de la tesis no tiene porque allí no hay sesión de R de
 * donde sacarlas.
 *
 * LA FIGURA
 * ---------
 * Un bloque como el de las tablas, sin líneas en blanco entre medias:
 *
 *   **Figura 1**
 *   *Distribución porcentual del nivel de gestión comercial*
 *   ![](figura1.png)
 *   *Nota.* Procesado en R 4.3.3.
 *
 * El nombre es el de un PNG de la carpeta de la sesión: «figura1.png», o
 * «graficos/grafico-01.png» si es de la última orden.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  AlignmentType,
  Footer,
  Header,
  PageNumber,
} = require('docx');

const documento = require('../projects/project.docx');
const { HUECO_RE } = require('../projects/project.citas');

/** Una línea que es solo una imagen: «![texto opcional](archivo.png)». */
const IMAGEN_RE = /^!\[[^\]]*\]\(\s*([^)\s]+)\s*\)$/;

/**
 * El tamaño máximo de una figura y el lector de PNG viven en `project.docx`,
 * que es donde se incrustan las figuras del Word de la tesis. Aquí se toman de
 * allí para que las dos salgan igual de anchas.
 */
const { ANCHO_MAXIMO, dimensionesPng } = documento;

/** Los bloques del texto: lo que separa una línea en blanco. */
function bloquesDe(texto) {
  return String(texto ?? '')
    .split(/\n{2,}/)
    .map((bloque) => bloque.trim())
    .filter(Boolean);
}

/** El bloque partido en lo de antes de la imagen, la imagen y lo de después. Null si no hay imagen. */
function partirFigura(bloque) {
  const lineas = bloque.split('\n').map((l) => l.trim());
  const indice = lineas.findIndex((l) => IMAGEN_RE.test(l));
  if (indice === -1) return null;

  return {
    antes: lineas.slice(0, indice).filter(Boolean),
    archivo: IMAGEN_RE.exec(lineas[indice])[1],
    despues: lineas.slice(indice + 1).filter(Boolean),
  };
}

/** Los archivos de figura que pide el texto, en orden y sin repetir. */
function figurasDe(texto) {
  const archivos = [];
  for (const bloque of bloquesDe(texto)) {
    const figura = partirFigura(bloque);
    if (figura && !archivos.includes(figura.archivo)) archivos.push(figura.archivo);
  }
  return archivos;
}

/** Cuántas tablas trae el texto, con la misma regla que las pinta. */
function cuantasTablas(texto) {
  return bloquesDe(texto).filter((bloque) => documento.partirTabla(bloque.split('\n'))).length;
}

/** «**Figura 1**» → «Figura 1»: el formato lo pone el Word. */
const sinEnfasis = (texto) =>
  String(texto).trim().replace(/^[*_]+\s*/, '').replace(/\s*[*_]+$/, '').trim();

/**
 * Un texto corto con sus citas puestas como texto.
 *
 * Para la nota de una figura: una nota al pie dentro de otra nota no la pide
 * ninguna norma, y el texto de la cita es lo que cabe ahí.
 */
function conCitasEnTexto(texto, citas) {
  return String(texto).replace(HUECO_RE, (_, n) => citas?.get(Number(n))?.texto ?? '');
}

/**
 * Una figura en el formato de APA 7: número en negrita y título en cursiva
 * encima, la imagen centrada y la nota debajo.
 */
function figuraApa({ antes, despues }, bytes, citas) {
  const [numero, ...titulo] = antes;
  const elementos = [];

  if (numero) {
    elementos.push(
      new Paragraph({
        children: [new TextRun({ text: sinEnfasis(numero), bold: true })],
        keepNext: true,
        spacing: { before: 240, after: 0 },
      }),
    );
  }
  if (titulo.length > 0) {
    elementos.push(
      new Paragraph({
        children: [new TextRun({ text: sinEnfasis(titulo.join(' ')), italics: true })],
        keepNext: true,
        spacing: { after: 120 },
      }),
    );
  }

  const { ancho, alto } = dimensionesPng(bytes);
  const escala = Math.min(1, ANCHO_MAXIMO / ancho);
  elementos.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: despues.length > 0,
      children: [
        new ImageRun({
          type: 'png',
          data: bytes,
          transformation: { width: Math.round(ancho * escala), height: Math.round(alto * escala) },
        }),
      ],
    }),
  );

  const nota = despues.join(' ');
  const conNota = nota.match(/^[*_]*Nota\.?[*_]*\s*(.*)$/i);
  elementos.push(
    new Paragraph({
      children: conNota
        ? [new TextRun({ text: 'Nota.', italics: true }), new TextRun(` ${conCitasEnTexto(conNota[1], citas)}`)]
        : nota
          ? [new TextRun(conCitasEnTexto(nota, citas))]
          : [new TextRun('')],
      spacing: { before: 120, after: 240, line: 240 },
    }),
  );

  return elementos;
}

/**
 * Arma el Word del informe.
 *
 * @param {object} datos
 * @param {string} [datos.titulo]      una línea por renglón: «CAPÍTULO IV\nRESULTADOS»
 * @param {string} [datos.tema]        el tema del proyecto, para el encabezado
 * @param {string} datos.texto         el Markdown con las citas ya como huecos (ver `project.csl`)
 * @param {Map}    [datos.citas]       lo que va en cada hueco; sin ella el texto sale tal cual
 * @param {Array|object} [datos.referencias]  la lista, como la da `project.csl` o el APA de respaldo
 * @param {Map<string, Buffer>} datos.figuras  el PNG de cada archivo que nombra el texto
 */
async function armar({ titulo = null, tema = null, texto, citas = null, referencias = [], figuras = new Map() }) {
  const notas = {};
  const contexto = { citas, notas, zotero: false, plantilla: false };
  const cuerpo = [];

  const renglones = String(titulo ?? '')
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
  renglones.forEach((renglon, i) => {
    cuerpo.push(
      new Paragraph({
        children: [new TextRun({ text: renglon, bold: true, size: 28 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: i === 0 ? 0 : 60, after: i === renglones.length - 1 ? 360 : 60 },
      }),
    );
  });

  // Bloque a bloque para que las figuras caigan en su sitio: `comoParrafos` no
  // sabe de imágenes, y fuera del orden del texto una figura no dice nada.
  for (const bloque of bloquesDe(texto)) {
    const figura = partirFigura(bloque);
    if (figura && figuras.has(figura.archivo)) {
      cuerpo.push(...figuraApa(figura, figuras.get(figura.archivo), citas));
    } else {
      cuerpo.push(...documento.comoParrafos(bloque, contexto));
    }
  }

  const lista = documento.referenciasDelDocumento(referencias, null, false);
  if (lista.parrafos.length > 0) {
    cuerpo.push(
      new Paragraph({
        children: [new TextRun({ text: lista.titulo, bold: true, size: 28 })],
        alignment: AlignmentType.CENTER,
        pageBreakBefore: true,
        spacing: { after: 240 },
      }),
      ...lista.parrafos,
    );
  }

  const informe = new Document({
    creator: 'Acosta | IA & Research',
    title: renglones.join(' ') || 'Informe de resultados',
    ...(Object.keys(notas).length > 0 ? { footnotes: notas } : {}),
    // Los mismos estilos que el Word de la tesis: si el tesista pega el informe
    // dentro, los títulos tienen que casar.
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
        heading2: {
          run: { font: 'Times New Roman', size: 24, bold: true, color: '000000' },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading3: {
          run: { font: 'Times New Roman', size: 24, bold: true, italics: true, color: '000000' },
          paragraph: { spacing: { before: 200, after: 120 } },
        },
        heading4: {
          run: { font: 'Times New Roman', size: 24, bold: true, color: '000000' },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1701, right: 1417, bottom: 1701, left: 1701 } },
        },
        ...(tema
          ? {
              headers: {
                default: new Header({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.RIGHT,
                      children: [new TextRun({ text: tema, size: 18, italics: true })],
                    }),
                  ],
                }),
              },
            }
          : {}),
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

  return documento.ajustarEstilos(await Packer.toBuffer(informe));
}

module.exports = { armar, figurasDe, cuantasTablas, dimensionesPng, partirFigura, ANCHO_MAXIMO };
