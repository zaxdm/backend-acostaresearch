'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { AppError } = require('../../shared/errors/AppError');
const { ERROR_CODES } = require('../../config/constants');

/**
 * Los archivos de la galería del bot de WhatsApp.
 *
 * Como los comprobantes: a disco y no a la base, con el nombre puesto por el
 * servidor y el formato deducido de los primeros bytes, no de lo que diga el
 * navegador. Solo PNG y JPEG porque son los únicos que WhatsApp manda como
 * imagen (el WebP lo trata como sticker), y hasta 5 MB, que es su tope.
 */

const MAX_BYTES = 5 * 1024 * 1024;

const FIRMAS = [
  {
    mime: 'image/png',
    ext: '.png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];

function detectar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  return FIRMAS.find((firma) => firma.test(buffer)) ?? null;
}

/** Ruta absoluta de una imagen, comprobando que no se sale de la carpeta. */
function rutaAbsoluta(relativa, raiz = env.whatsappImagenesDir) {
  const base = path.resolve(raiz);
  const destino = path.resolve(base, relativa);
  if (destino === base || !destino.startsWith(base + path.sep)) {
    throw new AppError('Ruta de imagen no válida.', { statusCode: 400, code: ERROR_CODES.VALIDATION_ERROR });
  }
  return destino;
}

/** Comprueba que es una imagen que WhatsApp acepta. Devuelve su formato. */
function comprobar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('No llegó ninguna imagen.', { statusCode: 400, code: ERROR_CODES.VALIDATION_ERROR });
  }
  if (buffer.length > MAX_BYTES) {
    throw new AppError('WhatsApp no acepta imágenes de más de 5 MB.', {
      statusCode: 413,
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  const firma = detectar(buffer);
  if (!firma) {
    throw new AppError('WhatsApp solo manda imágenes PNG o JPG. Conviértela y vuelve a subirla.', {
      statusCode: 415,
      code: ERROR_CODES.VALIDATION_ERROR,
    });
  }
  return firma;
}

const imagenesStorage = {
  MAX_BYTES,
  comprobar,

  /** Guarda la imagen y devuelve lo que se anota en la fila. */
  async guardar(buffer, raiz = env.whatsappImagenesDir) {
    const firma = comprobar(buffer);
    const archivo = `${crypto.randomUUID()}${firma.ext}`;
    const destino = rutaAbsoluta(archivo, raiz);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, buffer);
    return { archivo, mime: firma.mime, bytes: buffer.length };
  },

  async leer(archivo, raiz = env.whatsappImagenesDir) {
    return fs.readFile(rutaAbsoluta(archivo, raiz));
  },

  async borrar(archivo, raiz = env.whatsappImagenesDir) {
    try {
      await fs.unlink(rutaAbsoluta(archivo, raiz));
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn({ err: error, archivo }, 'WhatsApp: no se pudo borrar una imagen');
    }
  },
};

module.exports = imagenesStorage;
