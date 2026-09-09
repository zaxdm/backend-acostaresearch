'use strict';

/**
 * El texto de los capítulos, en disco.
 *
 * POR QUÉ NO EN LA BASE DE DATOS
 * ------------------------------
 * La base va en el plan Dev de un proveedor compartido y ya pesa 171 MB, de
 * los cuales 170 son el corpus bibliográfico. Una tesis completa ronda el medio
 * mega: doscientos tesistas serían cien megas más encima de una base que ya
 * está al límite, y además engordarían el volcado del respaldo diario todos los
 * días. En el disco del servidor hay 34 GB libres.
 *
 * La carpeta vive donde los comprobantes y los bundles —fuera del directorio
 * del código—, así que un despliegue no se la lleva por delante y el respaldo
 * diario ya la incluye sin tener que tocar nada.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const env = require('../../config/env');

/**
 * Nombres de archivo que se aceptan.
 *
 * El identificador del proyecto es un UUID que pone la base, y la clave del
 * capítulo viene del catálogo; ninguno de los dos debería traer sorpresas. Aun
 * así se comprueba, porque «debería» no es una garantía: basta con que un día
 * una clave admita un punto para que `../` deje de ser imposible y se pueda
 * escribir en cualquier sitio del disco.
 */
const SEGURO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

function rutaDe(projectId, skillCode) {
  if (!SEGURO.test(projectId) || !SEGURO.test(skillCode)) {
    throw new Error('Identificador de capítulo no válido');
  }
  return path.join(env.capitulosDir, projectId, `${skillCode}.md`);
}

/**
 * Cuenta palabras como las cuenta un jurado.
 *
 * Se quitan antes las marcas de Markdown. Son andamiaje para escribir, no
 * palabras del capítulo: contarlas infla la cuenta justo en los capítulos con
 * más subtítulos, y el número de palabras es de las pocas cifras que a un
 * tesista le miran de verdad.
 */
function palabrasDe(texto) {
  const limpio = texto
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+•]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .trim();

  return limpio === '' ? 0 : limpio.split(/\s+/).length;
}

/**
 * Escribe el capítulo, o lo alarga.
 *
 * `añadir` existe porque el cuerpo de una petición está limitado a 100 KB y un
 * capítulo de tesis puede pasar de eso. El asistente manda la primera parte sin
 * la marca y las siguientes con ella.
 *
 * Se escribe en un archivo temporal y se renombra encima. Un corte de luz a
 * mitad de una escritura directa deja el capítulo truncado, y el tesista no se
 * entera hasta que abre el Word.
 */
async function guardar(projectId, skillCode, texto, { anadir = false } = {}) {
  const ruta = rutaDe(projectId, skillCode);
  await fs.mkdir(path.dirname(ruta), { recursive: true });

  const anterior = anadir ? ((await leer(projectId, skillCode)) ?? '') : '';
  const completo = anterior === '' ? texto : `${anterior}\n\n${texto}`;

  const temporal = `${ruta}.parcial`;
  await fs.writeFile(temporal, completo, 'utf8');
  await fs.rename(temporal, ruta);

  return { palabras: palabrasDe(completo), bytes: Buffer.byteLength(completo, 'utf8') };
}

/** Devuelve null si ese capítulo todavía no se ha escrito. */
async function leer(projectId, skillCode) {
  try {
    return await fs.readFile(rutaDe(projectId, skillCode), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function borrar(projectId, skillCode) {
  try {
    await fs.unlink(rutaDe(projectId, skillCode));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Todo el proyecto, cuando se borra la cuenta. */
async function borrarProyecto(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  await fs.rm(path.join(env.capitulosDir, projectId), { recursive: true, force: true });
}

/**
 * El script de R y su salida, tal cual.
 *
 * Se guardan sin tocarlos y sin interpretarlos, por reproducibilidad: dentro de
 * un año, «¿de dónde salió este 0,42?» se responde abriendo el script que lo
 * produjo. Es lo que pide el §4.6 del brief y lo único de todo el análisis
 * estadístico que se puede garantizar sin ejecutar nada.
 *
 * `tipo` es «script» o «salida», y nada más: la extensión la decide este módulo
 * y no lo que venga de fuera.
 */
const EXTENSIONES = { script: 'R', salida: 'txt' };

function rutaDeAnalisis(projectId, skillCode, tipo) {
  const extension = EXTENSIONES[tipo];
  if (!extension) throw new Error('Tipo de archivo de análisis no válido');
  if (!SEGURO.test(projectId) || !SEGURO.test(skillCode)) {
    throw new Error('Identificador de análisis no válido');
  }
  return path.join(env.capitulosDir, projectId, `analisis-${skillCode}.${extension}`);
}

async function guardarAnalisis(projectId, skillCode, { script, salida } = {}) {
  const escritos = [];

  for (const [tipo, contenido] of Object.entries({ script, salida })) {
    if (!contenido) continue;
    const ruta = rutaDeAnalisis(projectId, skillCode, tipo);
    await fs.mkdir(path.dirname(ruta), { recursive: true });
    const temporal = `${ruta}.parcial`;
    await fs.writeFile(temporal, contenido, 'utf8');
    await fs.rename(temporal, ruta);
    escritos.push(tipo);
  }

  return escritos;
}

async function leerAnalisis(projectId, skillCode, tipo) {
  try {
    return await fs.readFile(rutaDeAnalisis(projectId, skillCode, tipo), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * La hoja de estilos de la plantilla del tesista.
 *
 * Un archivo por proyecto, al lado de sus capítulos. No lleva el nombre del
 * capítulo porque la plantilla es del proyecto entero: la universidad no cambia
 * a mitad de la tesis.
 */
function rutaDePlantilla(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  return path.join(env.capitulosDir, projectId, 'plantilla-estilos.xml');
}

async function guardarPlantilla(projectId, xml) {
  const ruta = rutaDePlantilla(projectId);
  await fs.mkdir(path.dirname(ruta), { recursive: true });
  const temporal = `${ruta}.parcial`;
  await fs.writeFile(temporal, xml, 'utf8');
  await fs.rename(temporal, ruta);
}

async function leerPlantilla(projectId) {
  try {
    return await fs.readFile(rutaDePlantilla(projectId), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function borrarPlantilla(projectId) {
  try {
    await fs.unlink(rutaDePlantilla(projectId));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  guardar,
  leer,
  borrar,
  borrarProyecto,
  palabrasDe,
  rutaDe,
  guardarAnalisis,
  leerAnalisis,
  guardarPlantilla,
  leerPlantilla,
  borrarPlantilla,
};
