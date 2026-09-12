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
 *
 * SOBRE LAS CITAS
 * ---------------
 * Llegan ya resueltas en la norma del proyecto (`project.csl`): el texto trae
 * un hueco donde va cada una, y aquí se decide cómo se pone. En las normas de
 * notas, un número volado y la cita en una nota al pie; en las demás, dentro
 * del texto con su formato. Si el tesista conectó Zotero, cada cita va además
 * envuelta en un campo de Zotero (`project.zotero-campos`).
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
  FootnoteReferenceRun,
  Tab,
  TabStopType,
} = require('docx');

const { HUECO_RE } = require('./project.citas');
const zoteroCampos = require('./project.zotero-campos');

/** Interlineado doble, en las unidades de OOXML (240 = sencillo). */
const DOBLE = 480;
/** Sangría de primera línea: media pulgada, en twips. */
const SANGRIA = 720;

/** Un tramo con formato, como los devuelve `project.csl`, hecho corrida de Word. */
function comoRun(tramo) {
  return new TextRun({
    text: tramo.texto,
    italics: Boolean(tramo.cursiva),
    bold: Boolean(tramo.negrita),
    superScript: Boolean(tramo.superindice),
    subScript: Boolean(tramo.subindice),
    smallCaps: Boolean(tramo.versalitas),
  });
}

/** Las corridas de una cita, envueltas en las marcas de campo si hay Zotero. */
function conCampo(tramos, clave, zotero) {
  const corridas = tramos.map(comoRun);
  if (!zotero) return corridas;
  return [
    new TextRun(zoteroCampos.marcaInicio(clave)),
    ...corridas,
    new TextRun(zoteroCampos.marcaFin(clave)),
  ];
}

/**
 * Una línea de texto hecha corridas, con sus citas puestas.
 *
 * Sin citas resueltas —una llamada antigua, o el APA de respaldo— la línea sale
 * tal cual, en una sola corrida, como siempre.
 */
function corridas(texto, contexto) {
  const { citas = null, notas = null, zotero = false } = contexto ?? {};
  if (!citas) return [new TextRun(texto)];

  const hijos = [];
  let desde = 0;

  for (const hueco of texto.matchAll(HUECO_RE)) {
    if (hueco.index > desde) hijos.push(new TextRun(texto.slice(desde, hueco.index)));
    desde = hueco.index + hueco[0].length;

    const cita = citas.get(Number(hueco[1]));
    if (!cita) continue;

    for (const tramo of cita.antes ?? []) hijos.push(comoRun(tramo));

    if (cita.nota && notas) {
      hijos.push(new FootnoteReferenceRun(cita.nota));
      notas[cita.nota] = {
        children: [new Paragraph({ children: conCampo(cita.tramos, hueco[1], zotero) })],
      };
    } else {
      hijos.push(...conCampo(cita.tramos, hueco[1], zotero));
    }
  }

  if (desde < texto.length) hijos.push(new TextRun(texto.slice(desde)));
  return hijos.length > 0 ? hijos : [new TextRun('')];
}

/**
 * Convierte el texto del capítulo en párrafos.
 *
 * El asistente escribe en Markdown porque es lo que sabe escribir, así que se
 * reconocen los encabezados y poco más. No se monta un analizador completo a
 * propósito: cuanto más se interpreta, más formas hay de estropear el texto de
 * alguien, y aquí el original es lo único que no se puede rehacer.
 */
function comoParrafos(texto, contexto = {}) {
  const parrafos = [];

  for (const bruto of texto.split(/\n{2,}/)) {
    const bloque = bruto.trim();
    if (bloque === '') continue;

    const encabezado = bloque.match(/^(#{1,4})\s+(.*)$/);
    if (encabezado) {
      const nivel = encabezado[1].length;
      // Una cita en un título no se pone como nota ni como campo: se deja su
      // texto, que es lo único que cabe en un encabezado.
      const titulo = encabezado[2]
        .trim()
        .replace(HUECO_RE, (_, n) => contexto.citas?.get(Number(n))?.texto ?? '');
      parrafos.push(
        new Paragraph({
          text: titulo,
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
          children: corridas(contenido.replace(/^\s*[-*•]\s+/, '• '), contexto),
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
 * Los párrafos de la lista de referencias.
 *
 * Admite las dos formas en que llega. La de siempre —una lista de entradas APA
 * en tramos o en texto— y la de la norma, que trae además cómo se maqueta:
 * sangría francesa, o la etiqueta «[1]» alineada a la izquierda como piden las
 * numéricas.
 *
 * La segunda línea y siguientes van sangradas y la primera no. En OOXML se
 * consigue sangrando el párrafo entero y devolviendo la primera línea con un
 * valor negativo; con etiqueta, una tabulación en esa misma sangría hace que el
 * texto de todas las líneas empiece a la misma altura.
 */
function referenciasDelDocumento(referencias, zotero) {
  if (Array.isArray(referencias)) {
    return {
      titulo: 'Referencias',
      parrafos: referencias.map(
        (entrada) =>
          new Paragraph({
            // Cada entrada llega partida en tramos porque APA pone en cursiva
            // el continente -la revista y su volumen, o el título si la obra se
            // sostiene sola- y una cursiva no cabe dentro de una cadena. Se
            // acepta también texto pelado por si alguien llama a esto con la
            // lista en plano.
            children:
              typeof entrada === 'string'
                ? [new TextRun(entrada)]
                : entrada.tramos.map(
                    (tramo) => new TextRun({ text: tramo.texto, italics: Boolean(tramo.cursiva) }),
                  ),
            spacing: { line: DOBLE },
            indent: { left: SANGRIA, hanging: SANGRIA },
          }),
      ),
    };
  }

  const entradas = referencias?.entradas ?? [];
  const alineada = Boolean(referencias?.etiquetaAlineada);
  const francesa = alineada || referencias?.sangriaFrancesa !== false;

  const parrafos = entradas.map((entrada, i) => {
    const hijos = [];
    // La bibliografía entera es UN campo de Zotero: empieza en la primera
    // entrada y acaba en la última.
    if (zotero && i === 0) hijos.push(new TextRun(zoteroCampos.marcaInicio('BIB')));
    if (alineada && entrada.etiqueta?.length) {
      hijos.push(...entrada.etiqueta.map(comoRun), new TextRun({ children: [new Tab()] }));
    }
    hijos.push(...entrada.tramos.map(comoRun));
    if (zotero && i === entradas.length - 1) hijos.push(new TextRun(zoteroCampos.marcaFin('BIB')));

    return new Paragraph({
      children: hijos,
      spacing: { line: DOBLE },
      ...(francesa ? { indent: { left: SANGRIA, hanging: SANGRIA } } : {}),
      ...(alineada ? { tabStops: [{ type: TabStopType.LEFT, position: SANGRIA }] } : {}),
    });
  });

  return { titulo: referencias?.titulo ?? 'Referencias', parrafos };
}

/**
 * Arma el documento.
 *
 * `capitulos` llega en el orden del método y solo con los que tienen texto: un
 * índice con capítulos vacíos haría creer que el documento está más avanzado de
 * lo que está.
 *
 * `citas` es lo que va en cada hueco del texto (ver `project.csl`); sin ella, el
 * texto sale como llega. `zotero`, cuando el tesista conectó el suyo, trae las
 * preferencias del documento y el código de campo de cada cita.
 */
async function armar({
  tema,
  carrera,
  universidad,
  nombre,
  capitulos,
  referencias = [],
  estilos = null,
  citas = null,
  zotero = null,
}) {
  const notas = {};
  const contexto = { citas, notas, zotero: Boolean(zotero) };

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
      ...comoParrafos(capitulo.texto, contexto),
    );
  }

  const lista = referenciasDelDocumento(referencias, zotero);
  if (lista.parrafos.length > 0) {
    cuerpo.push(
      new Paragraph({
        text: lista.titulo,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { after: 240 },
      }),
      ...lista.parrafos,
    );
  }

  /**
   * Los estilos de su facultad mandan sobre los nuestros.
   *
   * Cuando el tesista ha subido su plantilla, se usa la hoja de estilos de ese
   * documento y no la de aquí abajo: «Título 1» pasa a ser el Título 1 de su
   * universidad, con su fuente y su espaciado. Los dos no pueden convivir —Word
   * solo admite una definición por estilo—, y entre la suya y una que nos
   * inventamos, manda la suya.
   */
  const documento = new Document({
    creator: 'Acosta | IA & Research',
    title: tema ?? 'Tesis',
    ...(Object.keys(notas).length > 0 ? { footnotes: notas } : {}),
    ...(zotero ? { customProperties: zotero.preferencias } : {}),
    ...(estilos ? { externalStyles: estilos } : {}),
    ...(estilos ? {} : { styles: {
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
    } }),
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

  const buffer = await Packer.toBuffer(documento);
  return zotero ? zoteroCampos.coser(buffer, zotero.codigos) : buffer;
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
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  const fecha = new Date().toISOString().slice(0, 10);
  return `${base || 'tesis'}-${fecha}.docx`;
}

module.exports = { armar, nombreDeArchivo, comoParrafos };
