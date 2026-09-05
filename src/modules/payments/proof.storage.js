'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');

/**
 * Comprobantes de pago manual.
 *
 * Las capturas van a disco, no a la base de datos: pesan uno o dos megabytes y
 * dentro de una tabla que se consulta en cada compra solo estorban.
 *
 * EL TIPO SE DEDUCE DEL CONTENIDO, NO DE LO QUE DIGA EL NAVEGADOR
 * ---------------------------------------------------------------
 * La cabecera `Content-Type` la escribe quien sube el archivo, así que no
 * prueba nada: se leen los primeros bytes y se compara con la firma real del
 * formato. Un archivo que no empiece como una imagen no se guarda, y con eso
 * se descarta lo más obvio —subir un .html o un ejecutable a una carpeta del
 * servidor—. Además el nombre lo ponemos nosotros, nunca el cliente, de modo
 * que no hay forma de escaparse de la carpeta con un `../`.
 */

/** Firmas de los formatos que aceptamos. Un móvil produce PNG, JPEG o WebP. */
const FIRMAS = [
  { mime: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    ext: '.webp',
    test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

function detectar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  return FIRMAS.find((firma) => firma.test(buffer)) ?? null;
}

/** Ruta absoluta de un comprobante, comprobando que no se sale de la carpeta. */
function rutaAbsoluta(relativa) {
  const destino = path.resolve(env.PROOFS_DIR, relativa);
  const raiz = path.resolve(env.PROOFS_DIR);

  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
    throw new AppError('Ruta de comprobante no válida.', {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }

  return destino;
}

const proofStorage = {
  /**
   * Guarda la captura y devuelve la ruta relativa que se anota en el pago.
   *
   * Se reparte por año y mes para que la carpeta no acabe con diez mil
   * archivos sueltos, que es lo que hace insoportable buscar uno a mano.
   */
  async guardar(buffer, { paymentId }) {
    if (buffer.length > env.PROOF_MAX_BYTES) {
      throw new AppError(
        `La imagen no puede pesar más de ${Math.round(env.PROOF_MAX_BYTES / (1024 * 1024))} MB.`,
        { statusCode: 413, code: ERROR_CODES.VALIDATION_ERROR },
      );
    }

    const firma = detectar(buffer);
    if (!firma) {
      throw new AppError('Eso no parece una imagen. Sube una captura en PNG, JPG o WebP.', {
        statusCode: 415,
        code: ERROR_CODES.VALIDATION_ERROR,
      });
    }

    const ahora = new Date();
    const carpeta = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
    // El nombre lo pone el servidor: identificador del pago más azar, para que
    // no se pueda adivinar una URL de comprobante ajeno ni colisionar al
    // reemplazar una captura.
    const nombre = `${paymentId}-${crypto.randomBytes(6).toString('hex')}${firma.ext}`;
    const relativa = path.posix.join(carpeta, nombre);

    const destino = rutaAbsoluta(relativa);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, buffer);

    logger.info({ paymentId, bytes: buffer.length, mime: firma.mime }, 'Comprobante guardado');

    return { path: relativa, mime: firma.mime, bytes: buffer.length };
  },

  /** Lee un comprobante para enseñárselo al administrador. */
  leer(relativa) {
    return fs.readFile(rutaAbsoluta(relativa));
  },

  /**
   * Borra una captura. Se usa al reemplazarla por otra; un comprobante de un
   * pago ya aprobado NO se borra: es el justificante del cobro.
   */
  async borrar(relativa) {
    if (!relativa) return;
    try {
      await fs.unlink(rutaAbsoluta(relativa));
    } catch (error) {
      // Que ya no esté no es un problema: el objetivo era que no estuviera.
      if (error.code !== 'ENOENT') {
        logger.warn({ err: error, relativa }, 'No se pudo borrar un comprobante');
      }
    }
  },
};

module.exports = proofStorage;
