'use strict';

/**
 * La plantilla de la universidad del tesista.
 *
 * Cada universidad tiene la suya, y son distintas entre sí en cosas que un
 * jurado mira: la fuente de los títulos, la numeración de los apartados, los
 * márgenes. Adivinarlas es imposible y aproximarlas es peor que no intentarlo,
 * porque el tesista se confía y entrega algo que no cumple.
 *
 * CÓMO SE HACE
 * ------------
 * El tesista sube el .docx que le dio su facultad. De ese archivo se saca UNA
 * sola pieza: `word/styles.xml`, la definición de sus estilos. Al armar el Word
 * se usa esa definición en lugar de la nuestra, así que «Título 1» pasa a ser
 * el Título 1 de su universidad y el documento sale con su formato sin que
 * nadie tenga que copiar nada a mano.
 *
 * QUÉ NO SE GUARDA, Y ES LO IMPORTANTE
 * ------------------------------------
 * El contenido del archivo NO. Una plantilla de facultad suele venir con
 * ejemplos, con el nombre de otro tesista, a veces con una tesis entera dentro.
 * Nada de eso hace falta y nada de eso se queda: se extrae el formato —la hoja
 * de estilos, los márgenes, la numeración de los títulos, el encabezado y el
 * pie— y, de la portada, solo la primera página y solo si el tesista escribió
 * en ella marcas como {{TITULO}} (ver `project.plantilla-partes`). El resto se
 * descarta en memoria. Lo que no se guarda no se puede filtrar.
 */

const AdmZip = require('adm-zip');

/** Un .docx de plantilla no llega ni a un mega; cinco es de sobra. */
const MAXIMO_BYTES = 5 * 1024 * 1024;

/** Lo que hace que un archivo sea un .docx de verdad y no otra cosa renombrada. */
const OBLIGATORIOS = ['[Content_Types].xml', 'word/document.xml'];

class PlantillaNoValida extends Error {}

/**
 * Saca la hoja de estilos de un .docx.
 *
 * Devuelve el XML como texto. Lanza `PlantillaNoValida` con un mensaje que se
 * le puede enseñar al tesista tal cual: aquí los errores los va a leer alguien
 * que subió el archivo equivocado, no un programador.
 */
function extraerEstilos(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new PlantillaNoValida('El archivo llegó vacío. Vuelve a subirlo.');
  }

  if (buffer.length > MAXIMO_BYTES) {
    throw new PlantillaNoValida(
      'Ese archivo pesa demasiado para ser una plantilla. Sube el documento de formato que ' +
        'te dio tu facultad, no tu tesis.',
    );
  }

  // Un .docx es un zip. Un .doc antiguo no, y es el error más probable.
  if (buffer.subarray(0, 2).toString() !== 'PK') {
    throw new PlantillaNoValida(
      'Eso no es un .docx. Si tu plantilla es un .doc antiguo, ábrela en Word y guárdala ' +
        'como «Documento de Word (.docx)».',
    );
  }

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new PlantillaNoValida('No se pudo abrir el archivo. ¿Está completo?');
  }

  const dentro = new Set(zip.getEntries().map((e) => e.entryName));
  for (const necesario of OBLIGATORIOS) {
    if (!dentro.has(necesario)) {
      throw new PlantillaNoValida('Eso no parece un documento de Word. Sube el .docx de tu facultad.');
    }
  }

  const estilos = zip.getEntry('word/styles.xml');
  if (!estilos) {
    throw new PlantillaNoValida(
      'Ese documento no trae estilos definidos, así que no hay nada que copiar de él. ' +
        'Pide a tu facultad la plantilla con formato, no un documento en blanco.',
    );
  }

  const xml = estilos.getData().toString('utf8');

  if (!xml.includes('<w:styles')) {
    throw new PlantillaNoValida('Los estilos de ese documento no se pudieron leer.');
  }

  return xml;
}

/** Lo más grande que acepta Word para una medida de página, en twips (22 pulgadas). */
const MAXIMO_TWIPS = 31680;

/**
 * Los márgenes y el tamaño de página de la plantilla.
 *
 * Viven fuera de la hoja de estilos, en la sección del documento
 * (`<w:sectPr>` de `word/document.xml`), así que con solo los estilos el Word
 * salía con nuestros márgenes aunque la facultad pidiera otros. Se leen de la
 * ÚLTIMA sección, que es la que manda en un documento de una sola, y de ella
 * solo se sacan números: el texto del documento sigue sin guardarse.
 *
 * Devuelve null si no trae nada utilizable; entonces se usan los de siempre.
 */
function extraerPagina(buffer) {
  let xml;
  try {
    xml = new AdmZip(buffer).getEntry('word/document.xml')?.getData().toString('utf8');
  } catch {
    return null;
  }
  if (!xml) return null;

  const secciones = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)];
  const seccion = secciones.at(-1)?.[0];
  if (!seccion) return null;

  const atributos = (etiqueta) => {
    const m = seccion.match(new RegExp(`<w:${etiqueta}\\b([^>]*)/?>`));
    if (!m) return {};
    return Object.fromEntries(
      [...m[1].matchAll(/w:(\w+)="([^"]*)"/g)].map(([, nombre, valor]) => [nombre, valor]),
    );
  };

  // Word guarda negativos para «margen fijo aunque crezca el encabezado»; la
  // medida es la misma.
  const medida = (valor) => {
    const n = Math.abs(Number.parseInt(valor, 10));
    return Number.isInteger(n) && n <= MAXIMO_TWIPS ? n : undefined;
  };

  const mar = atributos('pgMar');
  const margen = {};
  for (const lado of ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter']) {
    const n = medida(mar[lado]);
    if (n !== undefined) margen[lado] = n;
  }
  const completo = ['top', 'right', 'bottom', 'left'].every((lado) => margen[lado] !== undefined);

  const sz = atributos('pgSz');
  const ancho = medida(sz.w);
  const alto = medida(sz.h);
  const tamano = ancho && alto ? { width: ancho, height: alto } : null;

  if (!completo && !tamano) return null;
  return { ...(completo ? { margen } : {}), ...(tamano ? { tamano } : {}) };
}

/**
 * Qué estilos trae, para poder decírselo al tesista.
 *
 * Enseñar «se aplicaron los estilos» no dice nada; enseñar «Título 1, Título 2,
 * Normal, Cita» le permite comprobar de un vistazo si subió el archivo bueno.
 */
function estilosQueTrae(xml) {
  const nombres = [...xml.matchAll(/<w:style [^>]*w:styleId="([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(nombres)];
}

module.exports = { extraerEstilos, extraerPagina, estilosQueTrae, PlantillaNoValida, MAXIMO_BYTES };
