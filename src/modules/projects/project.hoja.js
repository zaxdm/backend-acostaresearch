'use strict';

/**
 * Una hoja de cálculo (.xlsx) leída como texto.
 *
 * POR QUÉ EXISTE
 * --------------
 * La rúbrica de un docente y los términos de referencia de una empresa llegan
 * muchas veces en Excel: una fila por criterio, una columna por nivel. Eso no
 * es una matriz de datos —para esa está `r.formato`, que se la pasa a R—, es un
 * texto con forma de tabla, y lo único que hace falta es leerlo para que Claude
 * lo tenga delante.
 *
 * QUÉ SALE
 * --------
 * Una línea por fila, con las celdas separadas por « | », y antes de cada hoja
 * su nombre marcado con «[Hoja]». Las filas vacías se saltan. Las fórmulas no
 * se calculan: se lee el último valor que guardó Excel, que es lo que se veía
 * en la pantalla.
 *
 * Se lee a mano y no con una librería de Excel porque hace falta muy poco: el
 * texto de las celdas en orden. Lo que no se entienda se queda fuera, nunca
 * tumba la lectura.
 */

const { desescapar } = require('./project.documento');

/** Tope por hoja: una rúbrica tiene decenas de filas, no miles. */
const MAXIMO_FILAS = 2_000;

const entrada = (zip, ruta) => zip.getEntry(ruta)?.getData().toString('utf8') ?? null;

const atributo = (etiqueta, nombre) => {
  const m = new RegExp(`\\b${nombre}="([^"]*)"`).exec(etiqueta);
  return m ? desescapar(m[1]) : null;
};

/**
 * Las cadenas compartidas, en su orden: una celda de texto guarda el número de
 * la suya. Las vacías (`<si/>`) también ocupan sitio, y saltárselas correría
 * todas las demás.
 */
function cadenasCompartidas(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(([, dentro]) =>
    dentro ? textoDeCorridas(dentro) : '',
  );
}

/** El texto de un `<si>` o de un `<is>`: sus trozos (`<t>`) uno detrás de otro. */
function textoDeCorridas(xml) {
  return [...xml.matchAll(/<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map(([, dentro]) => (dentro ? desescapar(dentro) : ''))
    .join('');
}

/**
 * Las hojas del libro, en el orden en que salen sus pestañas.
 *
 * El nombre está en `workbook.xml` y el archivo de cada una en las relaciones:
 * el número del archivo no tiene por qué coincidir con el de la pestaña.
 */
function hojasDe(zip) {
  const libro = entrada(zip, 'xl/workbook.xml');
  if (!libro) return [];

  const relaciones = new Map(
    [...(entrada(zip, 'xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*\/?>/g)].map(([etiqueta]) => [
      atributo(etiqueta, 'Id'),
      atributo(etiqueta, 'Target'),
    ]),
  );

  return [...libro.matchAll(/<sheet\b[^>]*\/?>/g)]
    .map(([etiqueta]) => {
      const destino = relaciones.get(atributo(etiqueta, 'r:id'));
      if (!destino) return null;
      // «/xl/worksheets/hoja.xml» va desde la raíz; «worksheets/hoja.xml», desde xl/.
      const ruta = destino.startsWith('/') ? destino.slice(1) : `xl/${destino.replace(/^\.\//, '')}`;
      return { nombre: atributo(etiqueta, 'name') ?? '', ruta };
    })
    .filter((hoja) => hoja && zip.getEntry(hoja.ruta));
}

/** Lo que se ve en una celda: el texto compartido, el de dentro, o el número tal cual. */
function valorDeCelda(atributos, dentro, cadenas) {
  const tipo = atributo(atributos, 't');
  if (tipo === 'inlineStr') return textoDeCorridas(dentro ?? '');

  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(dentro ?? '');
  if (!v) return '';
  const crudo = desescapar(v[1]);
  return tipo === 's' ? (cadenas[Number(crudo)] ?? '') : crudo;
}

/** Las filas con algo escrito, cada una con sus celdas separadas por « | ». */
function filasDe(xml, cadenas) {
  if (!xml) return [];
  const filas = [];

  for (const [, cuerpo] of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = [...cuerpo.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
      .map(([, atributos, dentro]) => valorDeCelda(atributos, dentro, cadenas).replace(/\s+/g, ' ').trim())
      .filter((celda) => celda !== '');

    if (celdas.length === 0) continue;
    filas.push(celdas.join(' | '));
    if (filas.length >= MAXIMO_FILAS) {
      filas.push(`(El resto de la hoja no se leyó: pasa de ${MAXIMO_FILAS.toLocaleString('es')} filas.)`);
      break;
    }
  }

  return filas;
}

/**
 * El texto de un .xlsx ya abierto con `abrirZip`. Cadena vacía si no hay nada
 * escrito: quien llama decide qué decirle a quien lo subió.
 */
function textoDeExcel(zip) {
  const cadenas = cadenasCompartidas(entrada(zip, 'xl/sharedStrings.xml'));
  const lineas = [];

  for (const hoja of hojasDe(zip)) {
    const filas = filasDe(entrada(zip, hoja.ruta), cadenas);
    if (filas.length === 0) continue;
    lineas.push(`[Hoja] ${hoja.nombre}`, ...filas);
  }

  return lineas.join('\n');
}

/** ¿El zip es una hoja de cálculo? Un .docx y un .xlsx empiezan los dos por «PK». */
const esExcel = (zip) => Boolean(zip.getEntry('xl/workbook.xml'));

module.exports = { textoDeExcel, esExcel, MAXIMO_FILAS };
