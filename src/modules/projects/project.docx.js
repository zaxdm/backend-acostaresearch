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
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} = require('docx');

const AdmZip = require('adm-zip');

const { HUECO_RE } = require('./project.citas');
const zoteroCampos = require('./project.zotero-campos');
const partesDePlantilla = require('./project.plantilla-partes');

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
  if (!citas) return conEnfasis(texto);

  const hijos = [];
  let desde = 0;

  for (const hueco of texto.matchAll(HUECO_RE)) {
    if (hueco.index > desde) hijos.push(...conEnfasis(texto.slice(desde, hueco.index)));
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

  if (desde < texto.length) hijos.push(...conEnfasis(texto.slice(desde)));
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

  const celda = (texto, { esCabecera = false, ultimaFila = false } = {}) => {
    const negrita = /^\*\*.+\*\*$/.test(texto);
    const limpio = negrita ? texto.slice(2, -2) : texto;
    const hijos = negrita ? [new TextRun({ text: limpio, bold: true })] : corridas(limpio, contexto);
    return new TableCell({
      children: [
        new Paragraph({
          children: hijos,
          alignment: esCabecera ? AlignmentType.CENTER : AlignmentType.LEFT,
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
      width: { size: 100, type: WidthType.PERCENTAGE },
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
          children: cabecera.map((texto) => celda(texto, { esCabecera: true })),
        }),
        ...filas.map(
          (fila, i) =>
            new TableRow({
              children: ajustar(fila).map((texto) => celda(texto, { ultimaFila: i === filas.length - 1 })),
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
      spacing: { before: 120, after: 240, line: 240 },
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
      spacing: { before: 240, after: 0 },
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
        spacing: { after: 120 },
      }),
    );
  }

  for (const linea of despues) {
    if (MARCA_FIGURA_RE.test(linea)) {
      elementos.push(
        new Paragraph({
          children: [new TextRun({ text: textoDeMarca(linea, numero), highlight: 'yellow' })],
          alignment: AlignmentType.CENTER,
          keepNext: true,
          spacing: { before: 120, after: 120 },
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
        spacing: { before: 120, after: 240, line: 240 },
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
          ...(esLista
            ? { alignment: AlignmentType.LEFT, indent: { left: SANGRIA } }
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
function referenciasDelDocumento(referencias, zotero, plantilla = false) {
  // Siempre a la izquierda: justificadas, las entradas con URL o DOI largos
  // abrían huecos enormes entre palabras. Heredaban el justificado del
  // «Normal» de la plantilla. El interlineado, con plantilla, es el suyo.
  const formato = {
    alignment: AlignmentType.LEFT,
    ...(plantilla ? {} : { spacing: { line: DOBLE } }),
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
}) {
  const notas = {};
  const plantilla = Boolean(estilos);
  // Si la numeración de la plantilla ya escribe «Capítulo I», el título no lo
  // repite: saldría «CAPÍTULO I CAPÍTULO I · PROBLEMA Y OBJETIVOS».
  const numeraCapitulos = /<w:lvlText w:val="[^"]*cap[ií]tulo/i.test(partes?.numeracion ?? '');
  const contexto = { citas, notas, zotero: Boolean(zotero), plantilla };
  // El espaciado de los títulos de capítulo: con plantilla, el de su estilo.
  const espacioDeTitulo = plantilla ? {} : { spacing: { after: 240 } };

  const cuerpo = [
    // La portada de su facultad, si la plantilla la trae con marcas: aquí va un
    // hueco y se pone al final, ya empaquetado (ver `project.plantilla-partes`).
    ...(partes?.portada
      ? [new Paragraph({ text: partesDePlantilla.MARCA_PORTADA })]
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

  const lista = referenciasDelDocumento(referencias, zotero, plantilla);
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
      // La lista de referencias es un Título 1, pero no se numera.
      sinNumero: lista.parrafos.length > 0 ? [lista.titulo] : [],
    });
  }
  return zotero ? zoteroCampos.coser(buffer, zotero.codigos) : buffer;
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

module.exports = {
  armar,
  nombreDeArchivo,
  comoParrafos,
  ajustarEstilos,
  tituloDelCapitulo,
  partirTabla,
  tablaApa,
  // Lo usa también el informe de R (`r.informe`): misma lista, misma maqueta.
  referenciasDelDocumento,
};
