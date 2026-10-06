'use strict';

/**
 * Qué archivo es, por sus bytes.
 *
 * La extensión la pone quien sube el archivo y casi todas las páginas mandan
 * los bytes como `application/octet-stream`, así que lo único fiable es mirar
 * cómo empieza. Sirve para decirle al tesista qué subió cuando no se acepta
 * («eso es un documento de Pages») y para el aviso de subidas rechazadas
 * (ver `subidaRechazada`).
 *
 * Devuelve `{ clave, nombre, pista }`: `clave` para comparar con lo que acepta
 * cada subida, `nombre` para decírselo («un PDF»), y `pista`, si la hay, con
 * cómo convertirlo en lo que sí se acepta.
 */

const TIPOS = {
  pdf: { nombre: 'un PDF' },
  docx: { nombre: 'un Word (.docx)' },
  xlsx: { nombre: 'un Excel (.xlsx)' },
  pptx: {
    nombre: 'una presentación de PowerPoint',
    pista: 'Una presentación no se lee aquí: copia su contenido a un Word.',
  },
  ole: {
    nombre: 'un Word o un Excel antiguo (.doc o .xls)',
    pista: 'Ábrelo en Word o Excel y guárdalo como .docx o .xlsx («Guardar como»).',
  },
  odf: {
    nombre: 'un documento de LibreOffice u OpenOffice (.odt, .ods)',
    pista: 'Ábrelo en LibreOffice y guárdalo como Word (.docx) o Excel (.xlsx) con «Guardar como».',
  },
  iwork: {
    nombre: 'un documento de Pages o Numbers (Apple)',
    pista: 'Ábrelo en Pages o Numbers y expórtalo: Archivo → Exportar a → Word o Excel.',
  },
  zip: { nombre: 'un archivo comprimido (.zip)' },
  rar: {
    nombre: 'un archivo comprimido .rar o .7z',
    pista: 'Descomprímelo y sube los archivos de dentro.',
  },
  imagen: {
    nombre: 'una imagen o una foto',
    pista: 'Una captura o una foto no se puede leer como documento: sube el archivo original.',
  },
  heic: {
    nombre: 'una foto del iPhone (.heic)',
    pista: 'Una foto no se puede leer como documento: sube el archivo original.',
  },
  video: { nombre: 'un video' },
  audio: { nombre: 'un audio' },
  rtf: {
    nombre: 'un documento .rtf',
    pista: 'Ábrelo en Word y guárdalo como .docx («Guardar como»).',
  },
  sav: { nombre: 'un archivo de SPSS (.sav)' },
  html: {
    nombre: 'una página web (.html)',
    pista: 'Parece una página guardada del navegador, no el archivo: descarga el original y súbelo.',
  },
  texto: { nombre: 'un archivo de texto (.txt, .csv)' },
  desconocido: { nombre: 'un archivo que no reconocemos' },
};

function empiezaPor(bytes, firma, desde = 0) {
  if (bytes.length < desde + firma.length) return false;
  for (let i = 0; i < firma.length; i += 1) if (bytes[desde + i] !== firma[i]) return false;
  return true;
}

const ascii = (texto) => [...texto].map((c) => c.charCodeAt(0));
const contiene = (bytes, texto, hasta = 64 * 1024) => bytes.subarray(0, hasta).includes(Buffer.from(texto, 'latin1'));

/** La clave del tipo, por los primeros bytes. */
function claveDe(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;

  if (empiezaPor(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Un .docx, un .xlsx, un .odt o un .pages son todos .zip por dentro: se
    // distinguen por los nombres de lo que llevan, que van sin comprimir.
    if (contiene(bytes, 'word/')) return 'docx';
    if (contiene(bytes, 'xl/')) return 'xlsx';
    if (contiene(bytes, 'ppt/')) return 'pptx';
    if (contiene(bytes, 'mimetypeapplication/vnd.oasis.opendocument')) return 'odf';
    if (contiene(bytes, 'Index/Document.iwa') || contiene(bytes, 'Index/Tables') || contiene(bytes, '.iwa')) return 'iwork';
    return 'zip';
  }
  if (bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  if (empiezaPor(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (empiezaPor(bytes, ascii('$FL2')) || empiezaPor(bytes, ascii('$FL3'))) return 'sav';
  if (empiezaPor(bytes, ascii('Rar!')) || empiezaPor(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'rar';
  if (
    empiezaPor(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    empiezaPor(bytes, [0xff, 0xd8, 0xff]) ||
    empiezaPor(bytes, ascii('GIF8')) ||
    (empiezaPor(bytes, ascii('RIFF')) && empiezaPor(bytes, ascii('WEBP'), 8))
  ) {
    return 'imagen';
  }
  if (empiezaPor(bytes, ascii('ftyp'), 4)) {
    const marca = bytes.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|mif1|msf1)$/.test(marca)) return 'heic';
    if (/^M4A/.test(marca)) return 'audio';
    return 'video';
  }
  if (empiezaPor(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video';
  if (
    empiezaPor(bytes, ascii('ID3')) ||
    empiezaPor(bytes, [0xff, 0xfb]) ||
    empiezaPor(bytes, ascii('OggS')) ||
    (empiezaPor(bytes, ascii('RIFF')) && empiezaPor(bytes, ascii('WAVE'), 8))
  ) {
    return 'audio';
  }
  if (empiezaPor(bytes, ascii('{\\rtf'))) return 'rtf';

  const muestra = bytes.subarray(0, 8192);
  if (!muestra.includes(0x00)) {
    const inicio = muestra.toString('utf8').trimStart().slice(0, 200).toLowerCase();
    if (inicio.startsWith('<!doctype html') || inicio.startsWith('<html')) return 'html';
    return 'texto';
  }
  return 'desconocido';
}

/** Lo que dice la cabecera, para cuando los bytes no llegaron (el tipo no encajaba o pesaba de más). */
function claveDeCabecera(tipo) {
  const t = String(tipo ?? '').toLowerCase();
  if (!t || t.includes('octet-stream')) return null;
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('wordprocessingml')) return 'docx';
  if (t.includes('spreadsheetml')) return 'xlsx';
  if (t.includes('presentationml')) return 'pptx';
  if (t.includes('msword') || t.includes('ms-excel')) return 'ole';
  if (t.includes('opendocument')) return 'odf';
  if (t.includes('iwork') || t.includes('pages') || t.includes('numbers')) return 'iwork';
  if (t.includes('heic') || t.includes('heif')) return 'heic';
  if (t.startsWith('image/')) return 'imagen';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.includes('zip')) return 'zip';
  if (t.includes('rar') || t.includes('7z')) return 'rar';
  if (t.includes('rtf')) return 'rtf';
  if (t.includes('html')) return 'html';
  if (t.startsWith('text/') || t.includes('csv') || t.includes('json')) return 'texto';
  return null;
}

/** `{ clave, nombre, pista }` de unos bytes, o de la cabecera si no hay bytes. */
function tipoDeArchivo(bytes, cabecera) {
  const clave = claveDe(bytes) ?? claveDeCabecera(cabecera);
  if (!clave) return null;
  return { clave, ...TIPOS[clave] };
}

module.exports = { tipoDeArchivo, claveDe, claveDeCabecera, TIPOS };
