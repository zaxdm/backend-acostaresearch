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
  ImageRun,
  Table,
  TableRow,
  TableCell,
  TableLayoutType,
  WidthType,
  BorderStyle,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference,
} = require('docx');

const AdmZip = require('adm-zip');

const { HUECO_RE } = require('./project.citas');
const zoteroCampos = require('./project.zotero-campos');
const partesDePlantilla = require('./project.plantilla-partes');
const indice = require('./project.indice');

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

// ── Los pendientes ─────────────────────────────────────────────────────────

/**
 * Lo que las skills dejan marcado para completar: «[PENDIENTE — el año]».
 *
 * Se admite con guion, con raya o con dos puntos, y sin nada detrás, que es
 * como aparece en el método. El texto de dentro no puede llevar corchetes.
 */
const PENDIENTE_RE = /\[\s*PENDIENTE\s*(?:[—–:-]\s*)?([^\]]*)\]/gi;

/** Quién firma los comentarios del margen. */
const AUTOR_DE_COMENTARIOS = { author: 'Acosta | IA & Research', initials: 'AR' };

/**
 * Un pendiente, hecho comentario de Word en el margen.
 *
 * POR QUÉ NO SE DEJA EL TEXTO ENTERO EN EL PÁRRAFO
 * ------------------------------------------------
 * «[PENDIENTE — completar antes de imprimir: el año de la ordenanza]» dentro de
 * la frase rompe la lectura del capítulo, y es lo que veía el jurado si el
 * tesista imprimía sin repasar. En el margen se ve igual de claro, no estorba
 * al leer, y Word lo lista todo junto en el panel de revisión.
 *
 * EN EL CUERPO SE QUEDA UNA MARCA
 * -------------------------------
 * «[PENDIENTE]», resaltado. Un comentario solo se ve con el panel abierto, y
 * un pendiente que se puede pasar por alto no sirve de nada: la marca corta se
 * ve siempre, y la explicación queda al lado.
 */
function comoComentario(detalle, contexto) {
  const comentarios = contexto?.comentarios;
  const texto = String(detalle ?? '').trim();
  // Sin registro donde anotarlo —una llamada suelta, o las pruebas de una
  // función sola— el pendiente se queda como estaba: texto y nada más.
  if (!comentarios) return [new TextRun({ text: `[PENDIENTE${texto ? ` — ${texto}` : ''}]`, highlight: 'yellow' })];

  const id = comentarios.length;
  comentarios.push({
    id,
    ...AUTOR_DE_COMENTARIOS,
    date: contexto.fecha ?? new Date(),
    children: [new Paragraph(texto ? `Pendiente: ${texto}` : 'Pendiente de completar.')],
  });

  return [
    new CommentRangeStart(id),
    new TextRun({ text: '[PENDIENTE]', highlight: 'yellow' }),
    new CommentRangeEnd(id),
    new TextRun({ children: [new CommentReference(id)] }),
  ];
}

/** El texto con énfasis y con los pendientes sacados al margen. */
function conEnfasisYPendientes(texto, contexto) {
  if (!PENDIENTE_RE.test(texto)) return conEnfasis(texto);
  PENDIENTE_RE.lastIndex = 0;

  const hijos = [];
  let desde = 0;
  for (const m of texto.matchAll(PENDIENTE_RE)) {
    if (m.index > desde) hijos.push(...conEnfasis(texto.slice(desde, m.index)));
    hijos.push(...comoComentario(m[1], contexto));
    desde = m.index + m[0].length;
  }
  if (desde < texto.length) hijos.push(...conEnfasis(texto.slice(desde)));
  return hijos;
}

/**
 * Una línea de texto hecha corridas, con sus citas puestas.
 *
 * Sin citas resueltas —una llamada antigua, o el APA de respaldo— la línea sale
 * tal cual, en una sola corrida, como siempre.
 */
function corridas(texto, contexto) {
  const { citas = null, notas = null, zotero = false } = contexto ?? {};
  if (!citas) return conEnfasisYPendientes(texto, contexto);

  const hijos = [];
  let desde = 0;

  for (const hueco of texto.matchAll(HUECO_RE)) {
    if (hueco.index > desde) hijos.push(...conEnfasisYPendientes(texto.slice(desde, hueco.index), contexto));
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

  if (desde < texto.length) hijos.push(...conEnfasisYPendientes(texto.slice(desde), contexto));
  return hijos.length > 0 ? hijos : [new TextRun('')];
}

/**
 * **Negrita** y *cursiva* de Markdown, hechas formato de Word.
 *
 * Las skills las usan donde APA las pide —el término del marco conceptual en
 * negrita, los símbolos estadísticos como *p* o *M* en cursiva— y el Word las
 * enseñaba como asteriscos. Solo cuentan pegadas al texto: «2 * 3» no es una
 * cursiva. El guion bajo no se interpreta, porque aparece en los nombres de
 * variables de R.
 */
const ENFASIS_RE = /\*\*(?=\S)([^*]+?)(?<=\S)\*\*|\*(?=[^\s*])([^*]+?)(?<=\S)\*/g;

function conEnfasis(texto) {
  const hijos = [];
  let desde = 0;

  for (const m of texto.matchAll(ENFASIS_RE)) {
    if (m.index > desde) hijos.push(new TextRun(texto.slice(desde, m.index)));
    // Solo se pone lo que se marca: un «sin cursiva» explícito en la negrita
    // anularía la cursiva que traiga el estilo del párrafo o de la plantilla.
    hijos.push(new TextRun(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], italics: true }));
    desde = m.index + m[0].length;
  }

  if (desde < texto.length) hijos.push(new TextRun(texto.slice(desde)));
  return hijos.length > 0 ? hijos : [new TextRun('')];
}

// ── Tablas ─────────────────────────────────────────────────────────────────

/** Una fila de tabla en Markdown: «| a | b |». */
const FILA_RE = /^\s*\|.*\|\s*$/;
/** La fila que separa la cabecera del cuerpo: «|---|:---:|». */
const SEPARADOR_RE = /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/;

/** Las celdas de una fila. Un «\|» dentro de una celda es una barra de verdad. */
function celdasDe(linea) {
  const dentro = linea.trim().replace(/^\|/, '').replace(/\|$/, '');
  return dentro.split(/(?<!\\)\|/).map((celda) => celda.trim().replace(/\\\|/g, '|'));
}

/** «**Tabla 1**» → «Tabla 1»: el formato lo pone el Word, no los asteriscos. */
const sinEnfasis = (texto) => String(texto).trim().replace(/^[*_]+\s*/, '').replace(/\s*[*_]+$/, '').trim();

/**
 * Parte un bloque en lo que va antes de la tabla, la tabla y lo que va después.
 *
 * Null si el bloque no trae una tabla: hace falta la cabecera y, debajo, la fila
 * de guiones. Sin esa fila, unas líneas que empiezan por «|» son texto.
 */
function partirTabla(lineas) {
  const inicio = lineas.findIndex((l, i) => FILA_RE.test(l) && SEPARADOR_RE.test(lineas[i + 1] ?? ''));
  if (inicio === -1) return null;

  let fin = inicio + 2;
  while (fin < lineas.length && FILA_RE.test(lineas[fin])) fin += 1;

  return {
    antes: lineas.slice(0, inicio).map((l) => l.trim()).filter(Boolean),
    cabecera: celdasDe(lineas[inicio]),
    filas: lineas.slice(inicio + 2, fin).map(celdasDe),
    despues: lineas.slice(fin).map((l) => l.trim()).filter(Boolean),
  };
}

const LINEA_APA = { style: BorderStyle.SINGLE, size: 8, color: '000000' };
const SIN_LINEA = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

/** Página A4 con los márgenes de tesis: lo que queda para el texto, en twips. */
const ANCHO_POR_DEFECTO = 11906 - 1701 - 1417;
/** Ninguna columna baja de esto: media pulgada, o no cabe ni una palabra. */
const COLUMNA_MINIMA = 720;
/**
 * A partir de aquí, más texto ya no pide más ancho.
 *
 * Una celda de doscientos caracteres y otra de sesenta no necesitan columnas en
 * esa proporción: las dos van a partirse en varias líneas, y repartir por el
 * largo entero deja a las demás en un hilo. Cuarenta caracteres es lo que ocupa
 * una línea de celda cómoda.
 */
const LARGO_QUE_SATURA = 40;

/** Lo que queda para el texto entre los márgenes, con la plantilla o sin ella. */
function anchoDelCuerpo(pagina) {
  const ancho = pagina?.tamano?.width;
  const margen = pagina?.margen;
  if (!ancho || !margen) return ANCHO_POR_DEFECTO;
  return Math.max(2000, ancho - Math.abs(margen.left ?? 0) - Math.abs(margen.right ?? 0));
}

/**
 * El ancho de cada columna, por lo que lleva dentro.
 *
 * POR QUÉ NO SE DEJA A WORD
 * -------------------------
 * Sin anchos, Word reparte la tabla por su cuenta y una celda larga —la
 * pregunta de investigación en una matriz de consistencia— se come la mitad de
 * la hoja y deja «Sí/No» en una columna de tres líneas. El Word que armaba
 * Claude en el chat sí los cuadraba, y era la diferencia que se veía a simple
 * vista entre los dos documentos.
 *
 * Se reparte por el texto más largo de cada columna, saturado (ver
 * `LARGO_QUE_SATURA`) para que una celda enorme no se lo lleve todo, y con un
 * mínimo por columna. Si ni con el mínimo cabe —una tabla de doce columnas—, se
 * reparte por igual y que Word ajuste: es lo que hacía antes.
 */
function anchosDeColumna(filas, columnas, anchoUtil) {
  const total = Math.max(2000, Math.round(anchoUtil || ANCHO_POR_DEFECTO));
  if (columnas < 1) return [];
  if (columnas * COLUMNA_MINIMA > total) {
    return Array.from({ length: columnas }, () => Math.floor(total / columnas));
  }

  const pesos = Array.from({ length: columnas }, (_, i) =>
    Math.min(
      LARGO_QUE_SATURA,
      Math.max(1, ...filas.map((fila) => sinEnfasis(String(fila[i] ?? '')).length)),
    ),
  );
  const suma = pesos.reduce((a, b) => a + b, 0);

  // El reparto, y detrás el reajuste: subir una columna al mínimo le quita
  // ancho a las demás, y sin descontarlo la tabla se pasaba del margen.
  const anchos = pesos.map((peso) => Math.max(COLUMNA_MINIMA, Math.floor((total * peso) / suma)));
  let sobra = anchos.reduce((a, b) => a + b, 0) - total;
  while (sobra > 0) {
    const mayor = anchos.indexOf(Math.max(...anchos));
    const quita = Math.min(sobra, anchos[mayor] - COLUMNA_MINIMA);
    if (quita <= 0) break;
    anchos[mayor] -= quita;
    sobra -= quita;
  }
  // Lo que falte para cuadrar con el total, a la columna más ancha.
  if (sobra < 0) anchos[anchos.indexOf(Math.max(...anchos))] -= sobra;
  return anchos;
}

/**
 * Una tabla en el formato de APA 7.
 *
 * Encima, el número en negrita y el título en cursiva; tres líneas horizontales
 * —arriba, bajo la cabecera y al final— y ninguna vertical; debajo, la nota.
 * Es el formato que ya pedían las skills del método para la matriz de
 * consistencia, la operacionalización y los resultados: hasta ahora solo lo
 * conseguía el Word que armaba Claude, y en el del servidor la tabla salía como
 * texto con barras.
 *
 * Lo que Claude escribe, sin líneas en blanco entre medias:
 *
 *   **Tabla 1**
 *   *Matriz de consistencia*
 *   | Problema | Objetivo |
 *   |---|---|
 *   | ¿Cómo influye…? | Determinar… [AR97D22F86] |
 *   *Nota.* Elaboración propia.
 *
 * Las celdas admiten citas con clave, como el texto. El interlineado de la
 * tabla es sencillo aunque el del capítulo sea doble: una tabla a doble
 * espacio ocupa el doble y no la pide así ningún reglamento.
 */
function tablaApa({ antes, cabecera, filas, despues }, contexto) {
  const elementos = [];
  const [numero, ...titulo] = antes;
  const columnas = cabecera.length;

  if (numero) {
    elementos.push(
      new Paragraph({
        children: [new TextRun({ text: sinEnfasis(numero), bold: true })],
        keepNext: true,
        indent: { firstLine: 0 }, spacing: { before: 240, after: 0 },
      }),
    );
  }
  if (titulo.length > 0) {
    elementos.push(
      new Paragraph({
        children: [new TextRun({ text: sinEnfasis(titulo.join(' ')), italics: true })],
        keepNext: true,
        indent: { firstLine: 0 }, spacing: { after: 120 },
      }),
    );
  }

  // Las columnas, repartidas por lo que lleva cada una (ver `anchosDeColumna`).
  const anchos = anchosDeColumna([cabecera, ...filas], columnas, contexto?.anchoUtil);

  const celda = (texto, { esCabecera = false, ultimaFila = false, columna = 0 } = {}) => {
    const negrita = /^\*\*.+\*\*$/.test(texto);
    const limpio = negrita ? texto.slice(2, -2) : texto;
    const hijos = negrita ? [new TextRun({ text: limpio, bold: true })] : corridas(limpio, contexto);
    return new TableCell({
      width: { size: anchos[columna] ?? COLUMNA_MINIMA, type: WidthType.DXA },
      children: [
        new Paragraph({
          children: hijos,
          alignment: esCabecera ? AlignmentType.CENTER : AlignmentType.LEFT,
          // Sin la sangría de primera línea del texto, que con plantilla viene de «Normal».
          indent: { firstLine: 0 },
          spacing: { line: 240, before: 40, after: 40 },
        }),
      ],
      borders: {
        top: SIN_LINEA,
        left: SIN_LINEA,
        right: SIN_LINEA,
        bottom: esCabecera || ultimaFila ? LINEA_APA : SIN_LINEA,
      },
    });
  };

  // Todas las filas con las mismas columnas que la cabecera: una celda de más o
  // de menos en Markdown deja en Word una tabla con la fila descuadrada.
  const ajustar = (fila) => Array.from({ length: columnas }, (_, i) => fila[i] ?? '');

  elementos.push(
    new Table({
      width: { size: anchos.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      // Con el reparto automático, Word ignora la rejilla y vuelve a decidir
      // por el contenido: los anchos solo mandan con el diseño fijo.
      layout: TableLayoutType.FIXED,
      columnWidths: anchos,
      borders: {
        top: LINEA_APA,
        bottom: LINEA_APA,
        left: SIN_LINEA,
        right: SIN_LINEA,
        insideHorizontal: SIN_LINEA,
        insideVertical: SIN_LINEA,
      },
      rows: [
        new TableRow({
          tableHeader: true,
          children: cabecera.map((texto, columna) => celda(texto, { esCabecera: true, columna })),
        }),
        ...filas.map(
          (fila, i) =>
            new TableRow({
              children: ajustar(fila).map((texto, columna) =>
                celda(texto, { ultimaFila: i === filas.length - 1, columna }),
              ),
            }),
        ),
      ],
    }),
  );

  const nota = despues.join(' ');
  const conNota = nota.match(/^[*_]*Nota\.?[*_]*\s*(.*)$/i);
  elementos.push(
    new Paragraph({
      children: conNota
        ? [new TextRun({ text: 'Nota.', italics: true }), ...corridas(` ${conNota[1]}`, contexto)]
        : nota
          ? corridas(nota, contexto)
          : [new TextRun('')],
      // Siempre hay un párrafo detrás: Word no deja escribir entre una tabla y
      // lo que venga pegado a ella.
      indent: { firstLine: 0 }, spacing: { before: 120, after: 240, line: 240 },
    }),
  );

  return elementos;
}

// ── Figuras ────────────────────────────────────────────────────────────────

/** «**Figura 2**», la primera línea del rótulo de una figura. */
const FIGURA_RE = /^[*_]*\s*Figura\s+\d+[A-Za-z]?\s*[*_]*$/i;
/**
 * El hueco de la imagen: «[Insertar aquí la Figura 2: grafico.png]», o la
 * imagen en Markdown, «![](figura2.png)», que es como la escribe el informe de
 * R (`r.informe`). Aquí no está el archivo, así que las dos salen como la marca.
 */
const MARCA_FIGURA_RE = /^(\[Insertar aquí[^\]]*\]|!\[[^\]]*\]\([^)]+\))$/i;

/** Lo que se ve en la marca: la imagen en Markdown se dice con palabras. */
function textoDeMarca(linea, numero) {
  const imagen = linea.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
  return imagen ? `[Insertar aquí la ${sinEnfasis(numero)}: ${imagen[1]}]` : linea;
}

/**
 * Lo más ancha que sale una figura, en píxeles a 96 ppp: unos 15 cm, el ancho
 * de la caja de texto con márgenes de tesis. Una figura de R a 1600 píxeles
 * saldría del papel si se pusiera a su tamaño.
 *
 * Vivía en `r.informe`, que era el único que incrustaba imágenes; ahora el Word
 * de la tesis también, y el informe lo toma de aquí para que las dos midan igual.
 */
const ANCHO_MAXIMO = 560;

/** El ancho y el alto de un PNG, leídos de su cabecera. Null si no es un PNG. */
function dimensionesPng(bytes) {
  const firma = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24 || !firma.every((b, i) => bytes[i] === b)) return null;
  const ancho = bytes.readUInt32BE(16);
  const alto = bytes.readUInt32BE(20);
  return ancho > 0 && alto > 0 ? { ancho, alto } : null;
}

/**
 * De qué archivo es la marca de una figura.
 *
 * Solo PNG: es lo que genera R —y lo único cuyo tamaño se puede leer sin una
 * librería de imágenes—, así que una figura en otro formato sigue saliendo como
 * la marca amarilla de siempre, que es lo que había para todas.
 */
function archivoDeMarca(linea) {
  const enMarkdown = String(linea).match(/^!\[[^\]]*\]\(\s*([^)\s]+)\s*\)$/);
  const archivo = enMarkdown ? enMarkdown[1] : (String(linea).match(/:\s*([^\]\s]+)\s*\]$/) ?? [])[1];
  return archivo && /\.png$/i.test(archivo) ? archivo : null;
}

/** Los archivos de figura que pide un capítulo, en orden y sin repetir. */
function figurasDe(texto) {
  const archivos = [];
  for (const bruto of String(texto ?? '').split(/\n{2,}/)) {
    const lineas = bruto
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lineas.length === 0 || !FIGURA_RE.test(lineas[0])) continue;
    for (const linea of lineas) {
      const archivo = MARCA_FIGURA_RE.test(linea) ? archivoDeMarca(linea) : null;
      if (archivo && !archivos.includes(archivo)) archivos.push(archivo);
    }
  }
  return archivos;
}

/** La imagen, a lo ancho que quepa. Null si esos bytes no son un PNG. */
function comoImagen(bytes, keepNext) {
  const medidas = dimensionesPng(bytes);
  if (!medidas) return null;
  const escala = Math.min(1, ANCHO_MAXIMO / medidas.ancho);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext,
    indent: { firstLine: 0 },
    spacing: { before: 120, after: 120 },
    children: [
      new ImageRun({
        type: 'png',
        data: bytes,
        transformation: {
          width: Math.round(medidas.ancho * escala),
          height: Math.round(medidas.alto * escala),
        },
      }),
    ],
  });
}

/**
 * Una figura en el formato de APA 7, con el hueco para la imagen.
 *
 * El servidor no tiene la imagen —sale de R o de RStudio, en el equipo del
 * tesista—, así que se pone todo lo demás: el número en negrita, el título en
 * cursiva, la marca resaltada en amarillo donde va la imagen y la nota. Sin
 * esto el rótulo salía justificado y con sangría, como un párrafo cualquiera.
 *
 * Lo que Claude escribe, sin líneas en blanco entre medias:
 *
 *   **Figura 1**
 *   *Distribución de la motivación*
 *   [Insertar aquí la Figura 1: histograma-motivacion.png]
 *   *Nota.* Elaboración propia.
 */
function figuraApa(lineas, contexto) {
  const [numero, ...resto] = lineas.map((l) => l.trim()).filter(Boolean);
  const elementos = [
    new Paragraph({
      children: [new TextRun({ text: sinEnfasis(numero), bold: true })],
      keepNext: true,
      indent: { firstLine: 0 }, spacing: { before: 240, after: 0 },
    }),
  ];

  const titulo = [];
  const despues = [];
  for (const linea of resto) {
    if (MARCA_FIGURA_RE.test(linea) || despues.length > 0) despues.push(linea);
    else titulo.push(linea);
  }

  if (titulo.length > 0) {
    elementos.push(
      new Paragraph({
        children: [new TextRun({ text: sinEnfasis(titulo.join(' ')), italics: true })],
        keepNext: true,
        indent: { firstLine: 0 }, spacing: { after: 120 },
      }),
    );
  }

  for (const linea of despues) {
    if (MARCA_FIGURA_RE.test(linea)) {
      /**
       * La imagen, si el servidor la tiene.
       *
       * La tiene cuando el análisis se corrió aquí: los PNG quedan en la sesión
       * de R del proyecto (ver `armarWord`). Hasta ahora el Word de la tesis
       * dejaba SIEMPRE una marca amarilla para que el tesista pegara cada
       * imagen a mano, aunque el servidor acabara de dibujarlas él mismo.
       *
       * Si no la tiene —analizó en SPSS, o la figura es suya—, la marca sigue
       * ahí y se pega a mano, como antes.
       */
      const archivo = archivoDeMarca(linea);
      const imagen = archivo ? comoImagen(contexto?.figuras?.get(archivo), true) : null;
      elementos.push(
        imagen ??
          new Paragraph({
            children: [new TextRun({ text: textoDeMarca(linea, numero), highlight: 'yellow' })],
            alignment: AlignmentType.CENTER,
            keepNext: true,
            indent: { firstLine: 0 }, spacing: { before: 120, after: 120 },
          }),
      );
      continue;
    }
    const nota = linea.match(/^[*_]*Nota\.?[*_]*\s*(.*)$/i);
    elementos.push(
      new Paragraph({
        children: nota
          ? [new TextRun({ text: 'Nota.', italics: true }), ...corridas(` ${nota[1]}`, contexto)]
          : corridas(linea, contexto),
        indent: { firstLine: 0 }, spacing: { before: 120, after: 240, line: 240 },
      }),
    );
  }

  return elementos;
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

  /**
   * El título menos hondo del capítulo es su primer nivel, sea cual sea.
   *
   * Las once skills del método escriben `## 1.1 Planteamiento del problema`
   * como primer subtítulo del capítulo, nunca `#`. Contando las almohadillas a
   * pelo, ese «1.1» caía en Título 3 —negrita cursiva, que es el nivel 3 de
   * APA—, así que el tesista veía en cursiva lo que su facultad pide en
   * negrita, y colgando un escalón más abajo en el índice.
   *
   * Se mira lo que hay escrito y el más alto se coloca en Título 2, el primer
   * nivel por debajo del título del capítulo. La jerarquía interna no se toca:
   * un texto con `##` y `###` sigue saliendo en dos niveles distintos.
   */
  const niveles = [...texto.matchAll(/^(#{1,4})\s+\S/gm)].map((m) => m[1].length);
  const masAlto = niveles.length > 0 ? Math.min(...niveles) : 1;

  for (const bruto of texto.split(/\n{2,}/)) {
    const bloque = bruto.trim();
    if (bloque === '') continue;

    const encabezado = bloque.match(/^(#{1,4})\s+(.*)$/);
    if (encabezado) {
      const nivel = Math.min(3, encabezado[1].length - masAlto + 1);
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
          // Con plantilla, el espaciado del título es el de su estilo.
          ...(contexto.plantilla ? {} : { spacing: { before: 240, after: 120 } }),
        }),
      );
      continue;
    }

    const tabla = partirTabla(bloque.split('\n'));
    if (tabla) {
      parrafos.push(...tablaApa(tabla, contexto));
      continue;
    }

    if (FIGURA_RE.test(bloque.split('\n')[0])) {
      parrafos.push(...figuraApa(bloque.split('\n'), contexto));
      continue;
    }

    // Una cita en bloque («> …» en cada línea): la cita textual de 40 palabras o
    // más de APA 7, en su propio párrafo, sangrada entera y sin comillas. La usa
    // sobre todo el capítulo cualitativo, con lo que dijo cada entrevistado.
    const lineasDelBloque = bloque.split('\n');
    if (lineasDelBloque.every((l) => /^\s*>/.test(l))) {
      const cita = lineasDelBloque
        .map((l) => l.replace(/^\s*>\s?/, '').trim())
        .filter(Boolean)
        .join(' ');
      parrafos.push(
        new Paragraph({
          children: corridas(cita, contexto),
          ...(contexto.estiloCuerpo ? { style: contexto.estiloCuerpo } : {}),
          alignment: AlignmentType.JUSTIFIED,
          indent: { left: SANGRIA, firstLine: 0 },
          ...(contexto.plantilla ? {} : { spacing: { line: DOBLE } }),
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

      // Con plantilla, el interlineado, la sangría y la alineación del texto los
      // decide su estilo «Normal»: puestos aquí a mano la tapaban, y la tesis
      // salía a doble espacio aunque la facultad pidiera 1,5. Las listas
      // conservan su sangría izquierda, que es estructura y no formato.
      parrafos.push(
        new Paragraph({
          children: corridas(contenido.replace(/^\s*[-*•]\s+/, '• '), contexto),
          // El estilo del cuerpo de la plantilla, si lo trae (ver `project.plantilla`).
          ...(contexto.estiloCuerpo ? { style: contexto.estiloCuerpo } : {}),
          ...(esLista
            ? { alignment: AlignmentType.LEFT, indent: { left: SANGRIA, firstLine: 0 } }
            : contexto.plantilla
              ? {}
              : { alignment: AlignmentType.JUSTIFIED, indent: { firstLine: SANGRIA } }),
          ...(contexto.plantilla ? {} : { spacing: { line: DOBLE } }),
        }),
      );
    }
  }

  return parrafos;
}

/** La portada: lo poco que el servidor sabe con certeza. */
function portada({ tema, carrera, universidad, nombre, asesor }) {
  const centrado = (texto, opciones = {}) =>
    new Paragraph({
      children: [new TextRun({ text: texto, ...opciones })],
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      spacing: { after: 240 },
    });

  const hojas = [];
  if (universidad) hojas.push(centrado(universidad.toUpperCase(), { bold: true, size: 28 }));
  if (carrera) hojas.push(centrado(carrera, { size: 24 }));
  hojas.push(new Paragraph({ text: '', spacing: { after: 720 } }));
  hojas.push(centrado(tema ?? 'Tesis', { bold: true, size: 32 }));
  hojas.push(new Paragraph({ text: '', spacing: { after: 720 } }));
  if (nombre) hojas.push(centrado(nombre, { size: 24 }));
  if (asesor) hojas.push(centrado(`Asesor: ${asesor}`, { size: 24 }));

  return hojas;
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/** «octubre de 2026»: el mes de la entrega, o el de hoy si no se sabe. */
function fechaDePortada(fechaEntrega, ahora = new Date()) {
  const partes = /^(\d{4})-(\d{2})-\d{2}$/.exec(fechaEntrega ?? '');
  if (partes) return `${MESES[Number(partes[2]) - 1]} de ${partes[1]}`;
  return `${MESES[ahora.getMonth()]} de ${ahora.getFullYear()}`;
}

/**
 * La portada de un informe estudiantil.
 *
 * Aparte de la de tesis y no con parámetros dentro de ella: la de tesis la
 * vigila una instantánea y tiene que salir idéntica. La de un informe de curso
 * lleva lo que pide cualquier docente: institución, programa, curso, tema,
 * integrantes con su código, docente, ciclo y sección, y lugar y fecha. Lo que
 * no se sepa no sale; no se inventa.
 */
function portadaDeInforme({
  institucion,
  programa,
  curso,
  tema,
  tipo,
  docente,
  integrantes = [],
  nombre,
  cicloSeccion,
  ciudad,
  fechaEntrega,
}) {
  const centrado = (texto, opciones = {}, despues = 240) =>
    new Paragraph({
      children: [new TextRun({ text: texto, ...opciones })],
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      spacing: { after: despues },
    });
  const hueco = (despues) => new Paragraph({ text: '', spacing: { after: despues } });

  const hojas = [];
  if (institucion) hojas.push(centrado(institucion.toUpperCase(), { bold: true, size: 28 }));
  if (programa) hojas.push(centrado(programa, { size: 24 }));
  if (curso) hojas.push(centrado(`Curso: ${curso}`, { size: 24 }));
  hojas.push(hueco(720));
  hojas.push(centrado(tema ?? 'Informe', { bold: true, size: 32 }));
  if (tipo) hojas.push(centrado(tipo, { italics: true, size: 24 }));
  hojas.push(hueco(720));

  // Sin integrantes guardados, firma quien tiene la cuenta: es lo único seguro.
  const firmantes =
    Array.isArray(integrantes) && integrantes.length > 0
      ? integrantes.map((i) => (i.codigo ? `${i.nombre} (${i.codigo})` : i.nombre))
      : [nombre].filter(Boolean);
  if (firmantes.length > 0) {
    hojas.push(centrado(firmantes.length > 1 ? 'Integrantes' : 'Autor', { bold: true, size: 24 }, 120));
    firmantes.forEach((firmante, i) =>
      hojas.push(centrado(firmante, { size: 24 }, i === firmantes.length - 1 ? 240 : 60)),
    );
  }
  if (docente) hojas.push(centrado(`Docente: ${docente}`, { size: 24 }));
  if (cicloSeccion) hojas.push(centrado(cicloSeccion, { size: 24 }));

  hojas.push(hueco(480));
  const lugar = [ciudad, fechaDePortada(fechaEntrega)].filter(Boolean).join(', ');
  hojas.push(centrado(lugar.charAt(0).toUpperCase() + lugar.slice(1), { size: 24 }));

  return hojas;
}

/**
 * La portada de un informe de empresa.
 *
 * Hermana de `portadaDeInforme` y no una variante suya: la del informe de curso
 * la vigila una instantánea (`word.informe-curso`) y tiene que salir idéntica.
 * Un informe de empresa no lleva curso ni docente: lleva la empresa, a quién va,
 * quién lo firma y qué periodo cubre, y la marca de confidencial si se pidió.
 * Lo que no se sepa no sale; no se inventa.
 */
function portadaDeEmpresa({
  empresa,
  tema,
  tipo,
  destinatario,
  preparadoPor,
  cargo,
  nombre,
  periodo,
  ciudad,
  fechaEntrega,
  confidencial = false,
}) {
  const centrado = (texto, opciones = {}, despues = 240) =>
    new Paragraph({
      children: [new TextRun({ text: texto, ...opciones })],
      alignment: AlignmentType.CENTER,
      indent: { firstLine: 0 },
      spacing: { after: despues },
    });
  const hueco = (despues) => new Paragraph({ text: '', spacing: { after: despues } });

  const hojas = [];
  if (empresa) hojas.push(centrado(empresa.toUpperCase(), { bold: true, size: 28 }));
  hojas.push(hueco(960));
  hojas.push(centrado(tema ?? 'Informe', { bold: true, size: 32 }));
  if (tipo) hojas.push(centrado(tipo, { italics: true, size: 24 }));
  if (periodo) hojas.push(centrado(`Periodo: ${periodo}`, { size: 24 }));
  hojas.push(hueco(960));

  if (destinatario) hojas.push(centrado(`Preparado para: ${destinatario}`, { size: 24 }));
  // Sin quién lo firma guardado, firma la cuenta: es lo único seguro.
  const firma = [preparadoPor ?? nombre, cargo].filter(Boolean).join(', ');
  if (firma) hojas.push(centrado(`Preparado por: ${firma}`, { size: 24 }));

  hojas.push(hueco(480));
  const lugar = [ciudad, fechaDePortada(fechaEntrega)].filter(Boolean).join(', ');
  hojas.push(centrado(lugar.charAt(0).toUpperCase() + lugar.slice(1), { size: 24 }));

  if (confidencial === true) {
    hojas.push(hueco(480));
    hojas.push(centrado('Documento confidencial — uso interno', { bold: true, size: 20 }));
  }

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
function referenciasDelDocumento(referencias, zotero, plantilla = false, estiloCuerpo = null) {
  // Siempre a la izquierda: justificadas, las entradas con URL o DOI largos
  // abrían huecos enormes entre palabras. Heredaban el justificado del
  // «Normal» de la plantilla. El interlineado, con plantilla, es el suyo.
  const formato = {
    alignment: AlignmentType.LEFT,
    ...(plantilla ? {} : { spacing: { line: DOBLE } }),
    ...(estiloCuerpo ? { style: estiloCuerpo } : {}),
  };

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
            ...formato,
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
      ...formato,
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
  asesor = null,
  nombre,
  capitulos,
  referencias = [],
  estilos = null,
  pagina = null,
  partes = null,
  citas = null,
  zotero = null,
  /**
   * Los PNG de las figuras, por nombre de archivo, cuando el servidor los tiene
   * (ver `figurasDeLaSesion` en `project.service`). Sin ellos, cada figura sale
   * con su marca resaltada para pegarla a mano, como salían todas hasta ahora.
   */
  figuras = null,
  // Solo el informe estudiantil: los datos de su portada. Nulo = la de siempre.
  portadaInforme = null,
}) {
  const notas = {};
  /** Los pendientes del texto, que van al margen (ver `comoComentario`). */
  const comentarios = [];
  const plantilla = Boolean(estilos);
  // Si la numeración de la plantilla ya escribe «Capítulo I», el título no lo
  // repite: saldría «CAPÍTULO I CAPÍTULO I · PROBLEMA Y OBJETIVOS».
  const numeraCapitulos = /<w:lvlText w:val="[^"]*cap[ií]tulo/i.test(partes?.numeracion ?? '');
  // El texto va en «Cuerpo de tesis» si la plantilla lo trae: así toma su
  // interlineado y su sangría sin tocar «Normal», del que heredan la portada,
  // el encabezado y el pie.
  const estiloCuerpo = estilos && /w:styleId="CuerpoTesis"/.test(estilos) ? 'CuerpoTesis' : null;
  const contexto = {
    citas,
    notas,
    comentarios,
    figuras,
    zotero: Boolean(zotero),
    plantilla,
    estiloCuerpo,
    // Lo que mide una línea de texto: de ahí salen los anchos de las columnas
    // de las tablas (ver `anchosDeColumna`).
    anchoUtil: anchoDelCuerpo(pagina),
  };
  /**
   * El aspecto del título de capítulo: lo que la plantilla no diga, lo ponemos.
   *
   * Con plantilla se le dejaba TODO a su «Título 1», y eso da por hecho que el
   * archivo que subió trae estilos de verdad. Las plantillas convertidas desde
   * un PDF no los traen: sus títulos van con formato directo y el «Título 1»
   * que queda en la hoja de estilos es el genérico de Word, a la izquierda y
   * sin aire. El tesista abría su tesis y veía el capítulo pegado al
   * encabezado y alineado a la izquierda, con su reglamento pidiéndolo
   * centrado.
   *
   * Así que se mira qué dice su estilo y solo se rellena lo que falta. Si su
   * facultad centra, manda ella; si no dice nada, centrado y con aire encima,
   * que es como lo pide cualquier reglamento de tesis y lo que ya hacía
   * nuestro formato por defecto.
   */
  const suTitulo1 = plantilla ? loQueDiceElEstilo(estilos, 'Heading1') : null;
  const espacioDeTitulo = !plantilla
    ? { spacing: { after: 240 } }
    : {
        ...(suTitulo1?.alineacion ? {} : { alignment: AlignmentType.CENTER }),
        ...(suTitulo1?.espaciado ? {} : { spacing: { before: 480, after: 240 } }),
      };

  const cuerpo = [
    // La portada de su facultad, si la plantilla la trae con marcas: aquí va un
    // hueco y se pone al final, ya empaquetado (ver `project.plantilla-partes`).
    ...(partes?.portada
      ? [new Paragraph({ text: partesDePlantilla.MARCA_PORTADA })]
      : portadaInforme
        ? portadaInforme.ambito === 'empresa'
          ? portadaDeEmpresa(portadaInforme)
          : portadaDeInforme(portadaInforme)
        : portada({ tema, carrera, universidad, nombre, asesor })),
    new Paragraph({ text: '', pageBreakBefore: true }),
    // «TOC Heading» y no Título 1: se ve como un Título 1 pero no entra en el
    // índice. Con Título 1, el índice se listaba a sí mismo como primera
    // entrada. Es el mismo estilo que usa Word; ver `conTituloDelIndice`.
    new Paragraph({ text: 'Índice', style: 'TOCHeading' }),
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
        text: tituloDelCapitulo(capitulo.titulo, { sinCapitulo: numeraCapitulos }),
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        ...espacioDeTitulo,
      }),
      ...comoParrafos(capitulo.texto, contexto),
    );
  }

  const lista = referenciasDelDocumento(referencias, zotero, plantilla, estiloCuerpo);
  if (lista.parrafos.length > 0) {
    cuerpo.push(
      new Paragraph({
        text: lista.titulo,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        ...espacioDeTitulo,
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
    ...(comentarios.length > 0 ? { comments: { children: comentarios } } : {}),
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
        // El cuarto nivel («###» en el texto). Sin definirlo, salía con el azul
        // en cursiva de la librería, distinto de todo lo demás.
        heading4: {
          run: { font: 'Times New Roman', size: 24, bold: true, color: '000000' },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    } }),
    sections: [
      {
        properties: {
          page: {
            // Los de su plantilla si los traía (ver `project.plantilla`); si
            // no, márgenes de tesis: 3 cm arriba, izquierda y abajo; 2,5 a la
            // derecha. En twips, que es lo que entiende Word.
            margin: pagina?.margen ?? { top: 1701, right: 1417, bottom: 1701, left: 1701 },
            ...(pagina?.tamano ? { size: pagina.tamano } : {}),
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

  let buffer = await Packer.toBuffer(documento);
  buffer = ajustarEstilos(buffer, { quitarRepetidos: plantilla });
  if (partes) {
    buffer = partesDePlantilla.aplicar(buffer, partes, {
      tema,
      carrera,
      universidad,
      nombre,
      asesor,
      // Del informe: solo se usan si la portada de la plantilla los pide.
      curso: portadaInforme?.curso ?? null,
      docente: portadaInforme?.docente ?? null,
      cicloSeccion: portadaInforme?.cicloSeccion ?? null,
      integrantes: (portadaInforme?.integrantes ?? [])
        .map((i) => (i.codigo ? `${i.nombre} (${i.codigo})` : i.nombre))
        .join(', '),
      // Del informe de empresa. Sin «Preparado por» en la ficha firma quien tiene la cuenta.
      empresa: portadaInforme?.empresa ?? null,
      destinatario: portadaInforme?.destinatario ?? null,
      preparadoPor:
        portadaInforme?.ambito === 'empresa' ? (portadaInforme.preparadoPor ?? portadaInforme.nombre ?? null) : null,
      cargo: portadaInforme?.cargo ?? null,
      periodo: portadaInforme?.periodo ?? null,
      // La lista de referencias es un Título 1, pero no se numera.
      sinNumero: lista.parrafos.length > 0 ? [lista.titulo] : [],
    });
  }
  if (zotero) buffer = zoteroCampos.coser(buffer, zotero.codigos);
  // El índice, relleno: sin esto salía vacío en la vista protegida de Word y
  // en cualquier visor (ver `project.indice`).
  return indice.conIndice(buffer);
}

/** Un estilo entero de `styles.xml`, con su identificador. */
const ESTILO_RE =
  /<w:style\s[^>]*?w:styleId="([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/w:style>)/g;

/**
 * Deja una sola definición por estilo: la última, que es la de la plantilla.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * Con `externalStyles`, la librería `docx` mete igualmente sus estilos de
 * títulos —«Heading1» azul de 16 puntos— DELANTE de los de la plantilla. Word
 * se queda con la primera definición de cada identificador, así que de la
 * plantilla de la facultad solo se aplicaban la fuente y el interlineado del
 * texto normal, y los títulos salían con el azul de la librería. Se descubrió
 * el 13 de septiembre de 2026 subiendo una plantilla con títulos en Georgia
 * granate: el Word salía con dos «Heading1» y ganaba el que no era.
 *
 * Se quita en el XML ya empaquetado, como los campos de Zotero, porque la
 * librería no deja elegir qué estilos propios omitir.
 */
function sinEstilosRepetidos(xml) {
  const ultima = new Map();
  for (const m of xml.matchAll(ESTILO_RE)) ultima.set(m[1], m.index);

  return xml.replace(ESTILO_RE, (bloque, id, posicion) =>
    ultima.get(id) === posicion ? bloque : '',
  );
}

/**
 * El estilo del título «Índice», si la hoja de estilos no lo trae.
 *
 * Basado en Título 1 —así se ve como los demás títulos, los de la plantilla si
 * la hay— pero con nivel de esquema «texto normal», que es lo que lo deja fuera
 * del índice. Es como lo define el propio Word. Si la plantilla ya trae el
 * suyo, manda el suyo.
 */
const TITULO_DEL_INDICE =
  '<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/>' +
  '<w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:uiPriority w:val="39"/>' +
  // numId 0 = sin numeración: si la plantilla numera el Título 1, el título del
  // índice lo heredaba y salía «1. ÍNDICE», con los capítulos corridos a «2.».
  '<w:unhideWhenUsed/><w:qFormat/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>' +
  '<w:outlineLvl w:val="9"/></w:pPr></w:style>';

function conTituloDelIndice(xml) {
  if (/w:styleId="TOCHeading"/.test(xml) || !xml.includes('</w:styles>')) return xml;
  return xml.replace('</w:styles>', `${TITULO_DEL_INDICE}</w:styles>`);
}

/** Los retoques de `styles.xml` que la librería no deja hacer, en una sola pasada. */
function ajustarEstilos(buffer, { quitarRepetidos = false } = {}) {
  const zip = new AdmZip(buffer);
  const entrada = zip.getEntry('word/styles.xml');
  if (!entrada) return buffer;

  const antes = entrada.getData().toString('utf8');
  const despues = conTituloDelIndice(quitarRepetidos ? sinEstilosRepetidos(antes) : antes);

  if (despues === antes) return buffer;
  zip.updateFile('word/styles.xml', Buffer.from(despues, 'utf8'));
  return zip.toBuffer();
}

/**
 * Qué dice de verdad la plantilla sobre uno de sus estilos.
 *
 * Solo si lo dice: un `<w:style>` que existe pero no define ni alineación ni
 * espaciado no está diciendo nada, y es exactamente lo que deja una plantilla
 * convertida desde PDF. Sirve para completar sin pisar: lo que su facultad
 * escribió manda siempre.
 */
function loQueDiceElEstilo(estilos, id) {
  const bloque = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>([\\s\\S]*?)</w:style>`, 'i').exec(
    estilos ?? '',
  );
  if (!bloque) return null;

  return {
    alineacion: /<w:jc\b/.test(bloque[1]),
    espaciado: /<w:spacing\b/.test(bloque[1]),
  };
}

/**
 * El título del capítulo tal como va en la tesis.
 *
 * El catálogo numera los capítulos por su orden en el método —«2 · Capítulo I ·
 * Problema y objetivos», «Fase 3 — Introducción»— y ese número es del método,
 * no del documento: en la tesis salía «2 · CAPÍTULO I».
 */
function tituloDelCapitulo(titulo, { sinCapitulo = false } = {}) {
  const original = String(titulo ?? '');
  let limpio = original
    .replace(/^\s*\d+[a-z]?\s*·\s*/i, '')
    .replace(/^\s*fase\s+\d+[a-z]?\s*[—–-]\s*/i, '')
    .trim();
  // «Capítulo I · Problema y objetivos» → «Problema y objetivos», cuando el
  // número del capítulo ya lo pone la numeración de la plantilla.
  if (sinCapitulo) limpio = limpio.replace(/^cap[ií]tulo\s+[IVXLCDM\d]+\s*[·:.—–-]\s*/i, '').trim();
  return limpio || original;
}

/**
 * Nombre del archivo que descarga el tesista.
 *
 * Lleva la fecha porque el método pide versionar —V1, V2, V3— y con quince
 * archivos llamados «tesis.docx» en la carpeta de descargas nadie sabe cuál es
 * el bueno.
 */
function nombreDeArchivo(tema, respaldo = 'tesis') {
  const base = (tema ?? respaldo)
    .normalize('NFD')
    // El rango de las tildes, escrito con códigos y no con los signos: escritos
    // tal cual son invisibles en el editor y cualquiera los borra sin verlos.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  const fecha = new Date().toISOString().slice(0, 10);
  return `${base || respaldo}-${fecha}.docx`;
}

module.exports = {
  armar,
  nombreDeArchivo,
  comoParrafos,
  ajustarEstilos,
  tituloDelCapitulo,
  portadaDeInforme,
  portadaDeEmpresa,
  partirTabla,
  tablaApa,
  anchosDeColumna,
  figurasDe,
  dimensionesPng,
  ANCHO_MAXIMO,
  // Lo usa también el informe de R (`r.informe`): misma lista, misma maqueta.
  referenciasDelDocumento,
};
