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
const crypto = require('node:crypto');
const { enSerie } = require('../../shared/utils/enSerie');
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

  // Leer lo que había, juntarlo y escribir, de uno en uno por capítulo. Claude
  // manda a veces dos partes a la vez: las dos leían el texto de antes y la
  // segunda en escribir borraba la primera, que ya había contestado «Guardado».
  return enSerie(`capitulo:${ruta}`, async () => {
    const anterior = anadir ? ((await leer(projectId, skillCode)) ?? '') : '';
    const completo = anterior === '' ? texto : `${anterior}\n\n${texto}`;

    await escribirAtomico(ruta, completo, 'utf8');

    return { palabras: palabrasDe(completo), bytes: Buffer.byteLength(completo, 'utf8') };
  });
}

/**
 * Escribe en un temporal y lo renombra encima: un corte a mitad no deja el
 * archivo truncado.
 *
 * El temporal lleva un nombre propio en cada escritura. Con uno fijo
 * (`.parcial`), dos a la vez se truncaban el temporal la una a la otra, y la
 * segunda fallaba al renombrar un archivo que la primera ya se había llevado.
 *
 * Y las escrituras al mismo archivo van en turno: en Windows, dos renombrados a
 * la vez sobre el mismo destino dan EPERM. En Linux no pasa, pero así el
 * almacén se comporta igual en el servidor y en el equipo donde se prueba.
 */
function escribirAtomico(ruta, contenido, codificacion) {
  return enSerie(`archivo:${ruta}`, async () => {
    await fs.mkdir(path.dirname(ruta), { recursive: true });
    const temporal = `${ruta}.${crypto.randomUUID()}.parcial`;
    try {
      await fs.writeFile(temporal, contenido, codificacion);
      await fs.rename(temporal, ruta);
    } catch (error) {
      await fs.rm(temporal, { force: true }).catch(() => {});
      throw error;
    }
  });
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

/** Todo el proyecto: cuando su dueño lo borra, o borra la cuenta. */
async function borrarProyecto(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  await fs.rm(path.join(env.capitulosDir, projectId), { recursive: true, force: true });
  // Y su sesión de R, con la matriz que subió: sus datos no se quedan aquí
  // cuando se va. La carpeta se llama como el proyecto (ver `r.motor`).
  await fs.rm(path.join(env.rSesionesDir, projectId), { recursive: true, force: true });
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
    await escribirAtomico(rutaDeAnalisis(projectId, skillCode, tipo), contenido, 'utf8');
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
 * Cuándo se guardó la salida de un análisis, o null si no hay ninguna.
 *
 * Solo la fecha, sin abrir el archivo: se pregunta en cada «mi_proyecto» para
 * saber si hay un análisis por leer, y leer treinta mil caracteres para
 * contestar sí o no sería tirar la lectura.
 */
async function fechaDeAnalisis(projectId, skillCode) {
  try {
    const { mtime } = await fs.stat(rutaDeAnalisis(projectId, skillCode, 'salida'));
    return mtime;
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
  await escribirAtomico(rutaDePlantilla(projectId), xml, 'utf8');
}

async function leerPlantilla(projectId) {
  try {
    return await fs.readFile(rutaDePlantilla(projectId), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Márgenes y tamaño de página de la plantilla, al lado de sus estilos. */
function rutaDePagina(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  return path.join(env.capitulosDir, projectId, 'plantilla-pagina.json');
}

/** Con null se borra: una plantilla nueva sin márgenes no hereda los de la anterior. */
async function guardarPagina(projectId, pagina) {
  const ruta = rutaDePagina(projectId);
  if (!pagina) {
    await fs.unlink(ruta).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await escribirAtomico(ruta, JSON.stringify(pagina), 'utf8');
}

async function leerPagina(projectId) {
  try {
    return JSON.parse(await fs.readFile(rutaDePagina(projectId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Numeración, encabezado, pie y portada de la plantilla (ver
 * `project.plantilla-partes`), con sus imágenes en base64.
 *
 * Que exista el archivo también dice algo: las plantillas subidas antes de que
 * se copiaran estas partes no lo tienen, y el panel le pide al tesista que la
 * vuelva a subir.
 */
function rutaDePartes(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  return path.join(env.capitulosDir, projectId, 'plantilla-partes.json');
}

/** Lo que se tomó de la plantilla, sin las imágenes: es lo que lee el panel. */
function rutaDeResumen(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  return path.join(env.capitulosDir, projectId, 'plantilla-resumen.json');
}

async function escribirJson(ruta, valor) {
  if (valor === null || valor === undefined) {
    await fs.unlink(ruta).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await escribirAtomico(ruta, JSON.stringify(valor), 'utf8');
}

/** Con null se borran las partes y su resumen. */
async function guardarPartes(projectId, partes, resumen = null) {
  await escribirJson(rutaDePartes(projectId), partes);
  await escribirJson(rutaDeResumen(projectId), partes ? resumen : null);
}

async function leerResumenDePlantilla(projectId) {
  try {
    return JSON.parse(await fs.readFile(rutaDeResumen(projectId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function leerPartes(projectId) {
  try {
    return JSON.parse(await fs.readFile(rutaDePartes(projectId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function tienePartes(projectId) {
  try {
    await fs.access(rutaDePartes(projectId));
    return true;
  } catch {
    return false;
  }
}

async function borrarPlantilla(projectId) {
  await guardarPagina(projectId, null);
  await guardarPartes(projectId, null);
  try {
    await fs.unlink(rutaDePlantilla(projectId));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * El Word que subió el tesista para que Claude lo cite (ver `project.documento`).
 *
 * Se guarda ENTERO y tal cual, al revés que la plantilla: aquí el contenido es
 * justo lo que hay que devolverle, con sus citas puestas. Al lado van la ficha
 * —cómo se llamaba, cuándo se subió— y lo que Claude marcó en cada párrafo. El
 * Word citado no se guarda: se arma en cada descarga, así que cambiar de norma
 * no obliga a volver a citar.
 */
function rutaDeDocumento(projectId, que) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  const nombres = {
    original: 'documento-original.docx',
    ficha: 'documento.json',
    citas: 'documento-citas.json',
    reescritos: 'documento-reescritos.json',
  };
  return path.join(env.capitulosDir, projectId, nombres[que]);
}

async function guardarDocumento(projectId, buffer, ficha) {
  await escribirAtomico(rutaDeDocumento(projectId, 'original'), buffer);
  await escribirJson(rutaDeDocumento(projectId, 'ficha'), ficha);
}

async function leerJson(ruta) {
  try {
    return JSON.parse(await fs.readFile(ruta, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Null si no subió ninguno. */
async function leerDocumento(projectId) {
  try {
    return await fs.readFile(rutaDeDocumento(projectId, 'original'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const leerFichaDeDocumento = (projectId) => leerJson(rutaDeDocumento(projectId, 'ficha'));

/** `{ id del párrafo: texto con marcas }`. Vacío si todavía no se citó nada. */
async function leerCitasDeDocumento(projectId) {
  return (await leerJson(rutaDeDocumento(projectId, 'citas'))) ?? {};
}

const guardarCitasDeDocumento = (projectId, citados) =>
  escribirJson(rutaDeDocumento(projectId, 'citas'), citados);

/** `{ id del párrafo: { original, texto } }`, lo que humanizó Claude. Vacío si nada. */
async function leerReescritosDeDocumento(projectId) {
  return (await leerJson(rutaDeDocumento(projectId, 'reescritos'))) ?? {};
}

const guardarReescritosDeDocumento = (projectId, reescritos) =>
  escribirJson(rutaDeDocumento(projectId, 'reescritos'), reescritos);

async function borrarDocumento(projectId) {
  let habia = false;
  for (const que of ['original', 'ficha', 'citas', 'reescritos']) {
    try {
      await fs.unlink(rutaDeDocumento(projectId, que));
      habia = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return habia;
}

// ── El material del curso (informe estudiantil) ────────────────────────────

/** La consigna, la rúbrica o el índice, ya en texto. Ver `material.service`. */
function rutaDeMaterial(projectId) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  return path.join(env.capitulosDir, projectId, 'material-del-curso.json');
}

/** Null o lista vacía lo borra. */
async function guardarMaterial(projectId, lista) {
  await escribirJson(rutaDeMaterial(projectId), lista && lista.length > 0 ? lista : null);
}

async function leerMaterial(projectId) {
  return leerJson(rutaDeMaterial(projectId));
}

// ── El análisis cualitativo ────────────────────────────────────────────────

/**
 * Las entrevistas ya en texto y su codificación. Ver `cualitativo.service`.
 *
 * Dos archivos y no uno: las entrevistas se escriben al subir y la codificación
 * cada vez que Claude guarda una, y así ninguna de las dos reescribe el texto
 * entero de la otra.
 */
function rutaCualitativa(projectId, que) {
  if (!SEGURO.test(projectId)) throw new Error('Identificador de proyecto no válido');
  const nombres = { entrevistas: 'cualitativo-entrevistas.json', codificacion: 'cualitativo-codificacion.json' };
  if (!nombres[que]) throw new Error('Archivo cualitativo desconocido');
  return path.join(env.capitulosDir, projectId, nombres[que]);
}

/** Null lo borra. */
const guardarCualitativo = (projectId, que, valor) => escribirJson(rutaCualitativa(projectId, que), valor);

const leerCualitativo = (projectId, que) => leerJson(rutaCualitativa(projectId, que));

module.exports = {
  guardarCualitativo,
  leerCualitativo,
  guardarMaterial,
  leerMaterial,
  guardarDocumento,
  leerDocumento,
  leerFichaDeDocumento,
  leerCitasDeDocumento,
  guardarCitasDeDocumento,
  leerReescritosDeDocumento,
  guardarReescritosDeDocumento,
  borrarDocumento,
  guardar,
  leer,
  borrar,
  borrarProyecto,
  palabrasDe,
  rutaDe,
  guardarAnalisis,
  leerAnalisis,
  fechaDeAnalisis,
  guardarPlantilla,
  leerPlantilla,
  borrarPlantilla,
  guardarPagina,
  leerPagina,
  guardarPartes,
  leerPartes,
  tienePartes,
  leerResumenDePlantilla,
};
