'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../../config/env');
const { ValidationError } = require('../../shared/errors/AppError');

/**
 * Los Word que viajan por aquí: el capítulo que manda el tesista y las
 * versiones corregidas que adjunta después en la conversación.
 *
 * Están juntos porque se comprueban y se guardan igual, y porque el día que
 * cambie el criterio —otro formato, otro tamaño— tiene que cambiar en un sitio
 * y no en dos.
 *
 * EL NOMBRE CON EL QUE SE SUBIÓ NUNCA DECIDE DÓNDE SE ESCRIBE
 * -----------------------------------------------------------
 * La ruta la da el identificador de la fila. Un archivo llamado
 * `../../etc/passwd.docx` acabaría igualmente en su carpeta y con su nombre de
 * siempre.
 */

const carpetaDeMensajes = () => path.join(env.pedidosDir, 'mensajes');

/** El capítulo de un pedido. */
const rutaDelPedido = (id) => path.join(env.pedidosDir, `${id}.docx`);

/** Lo que se adjunta a un mensaje, en su propia carpeta. */
const rutaDelMensaje = (id) => path.join(carpetaDeMensajes(), `${id}.docx`);

/**
 * Que lo subido sea un .docx de verdad.
 *
 * Un .docx es un zip, así que empieza por «PK». El .doc de Word 97 empieza por
 * otra cosa y se distingue aquí para poder decírselo: «no es un Word» sería
 * falso y dejaría al tesista sin saber qué hacer, cuando la salida es
 * guardarlo otra vez con el formato de ahora.
 */
function comprobarDocx(archivo, nombre) {
  if (!Buffer.isBuffer(archivo) || archivo.length === 0) {
    throw new ValidationError('Falta el documento. Adjunta tu archivo de Word.');
  }
  if (archivo.length > env.PEDIDO_MAX_BYTES) {
    const megas = Math.floor(env.PEDIDO_MAX_BYTES / (1024 * 1024));
    throw new ValidationError(`El documento pasa de ${megas} MB.`);
  }

  const firma = archivo.subarray(0, 4);
  if (firma.toString('hex') === 'd0cf11e0') {
    throw new ValidationError(
      'Ese archivo es un Word antiguo (.doc). Ábrelo y guárdalo como .docx, y vuelve a subirlo.',
    );
  }
  if (firma.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new ValidationError('Ese archivo no es un documento de Word (.docx).');
  }
  if (!/\.docx$/i.test(String(nombre ?? ''))) {
    throw new ValidationError('Sube tu trabajo en Word (.docx).');
  }
}

/** Sin carpetas y recortado a lo que cabe en la columna. */
const nombreLimpio = (nombre) =>
  path.basename(String(nombre ?? '').trim() || 'documento.docx').slice(0, 200);

/** Escribe el archivo, creando la carpeta si hacía falta. */
async function guardar(ruta, archivo) {
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  await fs.writeFile(ruta, archivo);
}

module.exports = { comprobarDocx, nombreLimpio, guardar, rutaDelPedido, rutaDelMensaje };
