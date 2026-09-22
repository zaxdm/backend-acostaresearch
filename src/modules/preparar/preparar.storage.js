'use strict';

/**
 * Los .docx de «Preparar documento», en disco.
 *
 * POR QUÉ NO EN LA BASE DE DATOS
 * ------------------------------
 * Por lo mismo que los capítulos y los comprobantes: un Word de tesis con
 * figuras son varios megas, y diez documentos al mes por cliente engordarían el
 * volcado del respaldo todos los días. En el disco del servidor hay sitio.
 *
 * La carpeta cuelga de donde viven los comprobantes, así que el respaldo diario
 * ya se la lleva y un despliegue no puede borrarla. Ver `env.preparacionesDir`.
 *
 * QUÉ SE GUARDA
 * -------------
 * El que subió el cliente y el que se le devuelve. El de entrada se conserva
 * después de entregar, y a propósito: si una entrega sale mal —el modelo se
 * atragantó, el cliente dice que le falta un trozo— hay que poder repetirla sin
 * pedirle que vuelva a subir nada. Ver `limpiar` para cuándo se van.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const env = require('../../config/env');
const logger = require('../../config/logger');

/** Un UUID y nada más: es lo único que compone las rutas. */
const SEGURO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTRADA = 'entrada.docx';
const SALIDA = 'salida.docx';

function carpetaDe(preparacionId) {
  if (!SEGURO.test(String(preparacionId))) {
    throw new Error('Identificador de preparación no válido');
  }
  return path.join(env.preparacionesDir, preparacionId);
}

const rutaDe = (preparacionId, archivo) => path.join(carpetaDe(preparacionId), archivo);

/** Guarda el documento que subió el cliente. */
async function guardarEntrada(preparacionId, buffer) {
  const carpeta = carpetaDe(preparacionId);
  await fs.mkdir(carpeta, { recursive: true });
  await fs.writeFile(path.join(carpeta, ENTRADA), buffer);
}

/** Guarda el documento terminado. */
async function guardarSalida(preparacionId, buffer) {
  const carpeta = carpetaDe(preparacionId);
  await fs.mkdir(carpeta, { recursive: true });
  await fs.writeFile(path.join(carpeta, SALIDA), buffer);
}

const leerEntrada = (preparacionId) => fs.readFile(rutaDe(preparacionId, ENTRADA));
const leerSalida = (preparacionId) => fs.readFile(rutaDe(preparacionId, SALIDA));

/** ¿Está el documento terminado en disco? */
async function haySalida(preparacionId) {
  try {
    await fs.access(rutaDe(preparacionId, SALIDA));
    return true;
  } catch {
    return false;
  }
}

/**
 * Borra los dos archivos de una preparación.
 *
 * Un fallo al borrar no se propaga: se queda en el log. Lo que llama a esto es
 * el borrado de una cuenta o una limpieza, y ninguna de las dos puede quedarse
 * a medias porque un archivo estuviera abierto.
 */
async function borrar(preparacionId) {
  try {
    await fs.rm(carpetaDe(preparacionId), { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, preparacionId }, 'No se pudo borrar la carpeta de la preparación');
  }
}

module.exports = {
  carpetaDe,
  guardarEntrada,
  guardarSalida,
  leerEntrada,
  leerSalida,
  haySalida,
  borrar,
  ENTRADA,
  SALIDA,
};
