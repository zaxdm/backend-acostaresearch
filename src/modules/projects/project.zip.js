'use strict';

/**
 * Abrir un .docx que ha subido alguien sin fiarse de lo que dice de sí mismo.
 *
 * POR QUÉ EXISTE
 * --------------
 * adm-zip pone techo a lo que descomprime cada entrada: el tamaño que la propia
 * entrada declara. Pero solo si declara uno mayor que cero. Una entrada que
 * dice pesar 0 bytes se descomprime sin límite, y ese número lo escribe quien
 * fabrica el archivo. Un .docx de 5 MB con un `word/document.xml` hecho a mano
 * se convierte en varios GB en memoria y tumba el proceso —que es uno solo, el
 * de todos los compradores— en cuanto se lee.
 *
 * Aquí se mira el directorio central ANTES de descomprimir nada. Con cada
 * entrada declarando un tamaño acotado, el techo de adm-zip ya vale: lo que
 * salga de ella no puede pasar de lo declarado.
 *
 * Solo para lo que llega de fuera (el documento, la plantilla). Los Word que
 * arma este servidor se abren con adm-zip directamente.
 */

const AdmZip = require('adm-zip');

/** Método «sin comprimir»: se copia tal cual, así que no puede crecer. */
const SIN_COMPRIMIR = 0;

/**
 * Un archivo vacío comprimido ocupa 2 bytes, y según el programa hasta unos
 * pocos más. Con 64 bytes comprimidos no se llega ni a 70 KB: por debajo de
 * eso, declarar 0 no es peligroso.
 */
const VACIO_COMPRIMIDO = 64;

/** El document.xml de una tesis de 500 páginas ronda los 20 MB. */
const MAXIMO_POR_ENTRADA = 128 * 1024 * 1024;
const MAXIMO_TOTAL = 512 * 1024 * 1024;

class ZipSospechoso extends Error {}

/** Devuelve el `AdmZip`, o lanza `ZipSospechoso` si alguna entrada miente o no cabe. */
function abrirZip(buffer) {
  const zip = new AdmZip(buffer);

  let total = 0;
  for (const entrada of zip.getEntries()) {
    if (entrada.isDirectory) continue;
    const { size, compressedSize, method } = entrada.header;

    if (method !== SIN_COMPRIMIR && size === 0 && compressedSize > VACIO_COMPRIMIDO) {
      throw new ZipSospechoso(`La entrada ${entrada.entryName} declara 0 bytes y no está vacía.`);
    }
    if (size > MAXIMO_POR_ENTRADA) {
      throw new ZipSospechoso(`La entrada ${entrada.entryName} declara ${size} bytes.`);
    }

    total += size;
    if (total > MAXIMO_TOTAL) {
      throw new ZipSospechoso(`El archivo declara ${total} bytes descomprimido.`);
    }
  }

  return zip;
}

module.exports = { abrirZip, ZipSospechoso, MAXIMO_POR_ENTRADA, MAXIMO_TOTAL };
