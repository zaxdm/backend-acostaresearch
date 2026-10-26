'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../config/env');
const logger = require('../config/logger');

/**
 * La guía de instalación en PDF, lista para adjuntarla a un correo.
 *
 * Es el mismo archivo que sirve `/guias/guia-instalacion.pdf` (GUIAS_DIR), así
 * que cambiarla en el servidor cambia también la que va en el correo. Al
 * cliente le llega como «guia-de-instalacion.pdf».
 *
 * Si el archivo no está o no se puede leer, devuelve una lista vacía: el correo
 * sale igual con el enlace a la guía, que el código importa más que el adjunto.
 */
async function guiaDeInstalacion() {
  try {
    const content = await fs.readFile(path.join(env.GUIAS_DIR, 'guia-instalacion.pdf'));
    return [{ filename: 'guia-de-instalacion.pdf', content, contentType: 'application/pdf' }];
  } catch (error) {
    logger.warn({ err: error }, 'No se pudo adjuntar la guía de instalación al correo');
    return [];
  }
}

module.exports = { guiaDeInstalacion };
