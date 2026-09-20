'use strict';

/**
 * El material del curso: el texto de la consigna, la rúbrica o el índice que el
 * estudiante sube para que Claude lo lea. En un informe de empresa, los
 * requerimientos: los términos de referencia, el correo del pedido o la
 * plantilla que entregó el cliente.
 *
 * QUÉ SE LEE Y QUÉ NO
 * -------------------
 * Word (.docx), PDF con texto, Excel (.xlsx) y texto plano, que es como llegan
 * los requerimientos en la vida real: la consigna en Word, los términos en PDF
 * y la rúbrica en una hoja de Excel.
 *
 * Del Word se conserva el orden y se marcan los títulos y las líneas del
 * índice, que es justo lo que hace falta para armar el esquema con la
 * numeración que pidió el docente. La lectura de «Subir mi documento» se salta
 * el índice porque ahí no van citas; aquí es lo importante. Del Excel sale una
 * línea por fila, con su hoja marcada. Del PDF, los renglones vueltos a juntar
 * en párrafos, con el mismo criterio que las entrevistas del análisis
 * cualitativo: ahí está resuelto y no hay dos maneras de hacerlo.
 *
 * Un PDF escaneado —fotos de las hojas— y una imagen no traen texto: no se leen
 * en el servidor, y se rechazan con un mensaje que manda a adjuntarlos en el
 * chat de Claude, que sí los lee.
 */

const { abrirZip } = require('./project.zip');
const { parrafosDe } = require('./project.documento');
const { textoDeExcel, esExcel } = require('./project.hoja');
const { juntarLineas } = require('../cualitativo/cualitativo.lectura');

/** Un PDF de términos de referencia con el membrete escaneado pesa más que un Word. */
const MAXIMO_BYTES = 10 * 1024 * 1024;
const MAXIMO_ARCHIVOS = 5;
const MAXIMO_CARACTERES = 60_000;
const POR_PARTE = 20_000;

class MaterialNoValido extends Error {}

const EN_EL_CHAT =
  'Adjúntalo directamente en el chat de tu asistente, con el clip, que ahí sí lo lee; o ábrelo en ' +
  'Word y guárdalo como «Documento de Word (.docx)».';

function esImagen(cabeza) {
  const hex = cabeza.toString('hex');
  return (
    hex.startsWith('89504e47') || // PNG
    hex.startsWith('ffd8ff') || // JPG
    cabeza.subarray(0, 4).toString('latin1') === 'GIF8' ||
    (cabeza.subarray(0, 4).toString('latin1') === 'RIFF' && cabeza.subarray(8, 12).toString('latin1') === 'WEBP')
  );
}

/** Lo que se guarda, recortado a lo que cabe. */
function recortar(texto) {
  const limpio = String(texto).replace(/\r\n?/g, '\n').trim();
  if (limpio === '') throw new MaterialNoValido('Ese archivo no tiene texto que leer.');
  if (limpio.length <= MAXIMO_CARACTERES) return limpio;
  return `${limpio.slice(0, MAXIMO_CARACTERES)}\n(El resto del archivo no se guardó: pasa de 60.000 caracteres.)`;
}

/** Nivel de título por el identificador del estilo: «Heading2», «Ttulo2», «Título2». */
function nivelDeTitulo(estilo) {
  const m = /^(heading|t[ií]?tulo|ttulo)\s*(\d)/i.exec(String(estilo ?? ''));
  return m ? Number(m[2]) : null;
}

const esIndice = (estilo) => /^(toc|tdc)\s*\d/i.test(String(estilo ?? ''));

function textoDeWord(zip) {
  const xml = zip.getEntry('word/document.xml')?.getData().toString('utf8');
  if (!xml || !xml.includes('<w:body')) {
    throw new MaterialNoValido(`Eso no parece un documento de Word. ${EN_EL_CHAT}`);
  }

  const lineas = parrafosDe(xml)
    .filter((p) => p.texto.trim() !== '')
    .map((p) => {
      const nivel = nivelDeTitulo(p.estilo);
      const marca = esIndice(p.estilo)
        ? '[Índice] '
        : nivel
          ? `[Título ${nivel}] `
          : p.enTabla
            ? '[tabla] '
            : '';
      return `${marca}${p.texto.trim()}`;
    });

  return recortar(lineas.join('\n'));
}

/**
 * El texto de un PDF: sus renglones vueltos a juntar en párrafos.
 *
 * Un PDF escaneado no tiene texto que sacar. Se reconoce porque no sale casi
 * nada, y se dice por qué: leerlo pediría reconocimiento óptico, y en unos
 * términos de referencia un error del OCR sería una condición inventada.
 */
async function textoDePdf(buffer) {
  let paginas;
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    ({ text: paginas } = await extractText(pdf, { mergePages: false }));
  } catch {
    throw new MaterialNoValido('No se pudo abrir el PDF. ¿Está completo o tiene contraseña?');
  }

  const parrafos = juntarLineas(paginas.flatMap((pagina) => [...String(pagina).split('\n'), '']));
  if (parrafos.join('').replace(/\s/g, '').length < 100) {
    throw new MaterialNoValido(
      'Ese PDF no tiene texto: parece escaneado (fotos de las hojas). Adjúntalo directamente en el ' +
        'chat de tu asistente, con el clip, que ahí sí lo lee; o súbelo en Word.',
    );
  }
  return recortar(parrafos.join('\n'));
}

/** El texto de una hoja de cálculo: una línea por fila, con su hoja marcada. */
function textoDeHoja(zip) {
  const texto = textoDeExcel(zip);
  if (texto.trim() === '') {
    throw new MaterialNoValido('Esa hoja de cálculo no tiene nada escrito que leer.');
  }
  return recortar(texto);
}

/** El texto del archivo subido, o lanza `MaterialNoValido` con un mensaje para el estudiante. */
async function textoDe(buffer) {
  if (!buffer || buffer.length === 0) throw new MaterialNoValido('El archivo llegó vacío. Vuelve a subirlo.');
  if (buffer.length > MAXIMO_BYTES) {
    throw new MaterialNoValido(
      `Ese archivo pasa de ${MAXIMO_BYTES / 1024 / 1024} MB. Sube solo lo que te pidieron: la ` +
        'consigna, la rúbrica, el índice o los términos de referencia.',
    );
  }

  const cabeza = buffer.subarray(0, 12);
  if (cabeza.subarray(0, 4).toString('latin1') === '%PDF') return textoDePdf(buffer);
  if (esImagen(cabeza)) {
    throw new MaterialNoValido(
      'Es una imagen, y aquí se leen documentos, no fotos. Adjúntala directamente en el ' +
        'chat de tu asistente, con el clip, que ahí sí la lee.',
    );
  }
  if (cabeza[0] === 0xd0 && cabeza[1] === 0xcf) {
    throw new MaterialNoValido(
      'Es un archivo antiguo de Office (.doc o .xls). Ábrelo y guárdalo como «Documento de Word ' +
        '(.docx)» o como «Libro de Excel (.xlsx)».',
    );
  }

  if (cabeza.subarray(0, 2).toString('latin1') === 'PK') {
    let zip;
    try {
      zip = abrirZip(buffer);
    } catch {
      throw new MaterialNoValido('No se pudo abrir el archivo. ¿Está completo?');
    }
    return esExcel(zip) ? textoDeHoja(zip) : textoDeWord(zip);
  }

  const texto = buffer.toString('utf8');
  if (texto.includes('\u0000')) {
    throw new MaterialNoValido(`Ese archivo no se puede leer como texto. ${EN_EL_CHAT}`);
  }
  return recortar(texto);
}

/** Partes de hasta `POR_PARTE` caracteres, cortadas entre líneas. */
function enPartes(texto) {
  const partes = [];
  let actual = '';
  for (const linea of String(texto).split('\n')) {
    if (actual !== '' && actual.length + linea.length + 1 > POR_PARTE) {
      partes.push(actual);
      actual = '';
    }
    actual = actual === '' ? linea : `${actual}\n${linea}`;
  }
  if (actual !== '' || partes.length === 0) partes.push(actual);
  return partes;
}

/** El nombre para enseñar: de una línea y corto. Nunca se usa para escribir en disco. */
function nombreSeguro(nombre) {
  const limpio = String(nombre ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  return limpio || 'material';
}

/** La lista sin el texto, numerada: lo que ven el panel, la página y Claude. */
function fichas(lista) {
  return (lista ?? []).map((m, i) => ({
    numero: i + 1,
    nombre: m.nombre,
    subidoAt: m.subidoAt,
    caracteres: m.caracteres,
  }));
}

/**
 * La línea del panorama del informe.
 *
 * `empresa`: el informe es de empresa, y lo que se sube son los términos de
 * referencia o los documentos que entregó. La de curso no cambia.
 */
function lineaDeMaterial(lista, { empresa = false } = {}) {
  if (empresa) {
    if (!lista || lista.length === 0) {
      return (
        'Material del encargo: nada subido. Si tiene los términos de referencia, el correo del ' +
        'pedido, la plantilla o documentos de la empresa en Word, PDF, Excel o texto, dale el ' +
        'enlace con "material_del_curso"; si son fotos o un PDF escaneado, que los adjunte en el chat.'
      );
    }
    const nombres = lista.map((m, i) => `${i + 1}. ${m.nombre}`).join('; ');
    return `Material del encargo, léelo con "material_del_curso" y su número: ${nombres}.`;
  }
  if (!lista || lista.length === 0) {
    return (
      'Material del curso: nada subido. Si el estudiante tiene la consigna, la rúbrica o el índice ' +
      'en Word, PDF, Excel o texto, dale el enlace con "material_del_curso"; si lo tiene en foto o ' +
      'en un PDF escaneado, que lo adjunte en el chat.'
    );
  }
  const nombres = lista.map((m, i) => `${i + 1}. ${m.nombre}`).join('; ');
  return `Material del curso, léelo con "material_del_curso" y su número: ${nombres}.`;
}

module.exports = {
  textoDe,
  enPartes,
  nombreSeguro,
  fichas,
  lineaDeMaterial,
  MaterialNoValido,
  MAXIMO_BYTES,
  MAXIMO_ARCHIVOS,
  MAXIMO_CARACTERES,
  POR_PARTE,
};
