'use strict';

/**
 * Citar el Word que subió el tesista: lo que junta el archivo, sus fuentes y la
 * norma del proyecto. Cómo se escribe dentro del Word está en `project.documento`.
 *
 * EL RECORRIDO
 * ------------
 * 1. El tesista sube su .docx desde el panel. Se guarda entero.
 * 2. En la conversación, Claude lo lee por párrafos (`ver`), busca fuentes y le
 *    enseña un resumen antes de tocar nada.
 * 3. Con su visto bueno, manda los párrafos con las marcas puestas (`citar`).
 *    Solo se guardan las marcas: el Word no se toca hasta que se descarga.
 * 4. Cada descarga (`armar`) pone las citas en la norma que tenga el proyecto en
 *    ese momento. Cambiar de norma no obliga a volver a citar.
 */

const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const documento = require('./project.documento');
const normas = require('./project.normas');
const citas = require('./project.citas');
const descarga = require('./project.descarga');
const referenceService = require('../references/reference.service');

/** Caracteres de texto por cada respuesta de `ver`: lo que cabe holgado en una llamada del conector. */
const POR_TANDA = 24000;

const contarMarcas = (texto) => [...String(texto).matchAll(citas.MARCA)].length;
const contarFaltas = (texto) => String(texto).match(documento.FALTA)?.length ?? 0;

/** La norma, sin pasar por `project.service`, que es quien importa este módulo. */
function normaDe(proyecto) {
  const norma = normas.normaDe(proyecto?.estiloCitas);
  return { id: norma.id, nombre: norma.nombre, familia: norma.familia, elegida: Boolean(proyecto?.estiloCitas) };
}

/**
 * El proyecto, creado si hace falta, pero solo con licencia vigente del método.
 *
 * Es el mismo criterio que la norma y el análisis: el proyecto nace del
 * conector, y crearlo desde la web sin licencia sería tener el de un método que
 * no se compró.
 *
 * La licencia se mira SIEMPRE, también si el proyecto ya existe: que exista no
 * prueba nada —puede ser de una licencia caducada, o de antes de que la
 * plantilla la exigiera— y aquí se suben hasta 40 MB por vez.
 */
async function proyectoConLicencia(userId, productCode) {
  const conLicencia = await projectRepository.productosConLicencia(userId);
  if (!conLicencia.includes(productCode)) return null;
  const actual = await projectRepository.buscar(userId, productCode);
  return actual ?? projectRepository.asegurar(userId, productCode);
}

async function cargar(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;
  const buffer = await almacen.leerDocumento(proyecto.id);
  return buffer ? { proyecto, buffer } : null;
}

/**
 * Guarda el Word que subió.
 *
 * Si ya había uno citado, las citas se pasan al nuevo por el texto de cada
 * párrafo: corregir una coma y volver a subirlo no puede costarle las demás.
 * Devuelve null si no tiene licencia de ese método.
 */
async function subir({ userId, productCode, buffer, nombre }) {
  const parrafos = documento.leer(buffer);
  if (parrafos.length === 0) {
    throw new documento.DocumentoNoValido('Ese documento no tiene texto que citar.');
  }

  const proyecto = await proyectoConLicencia(userId, productCode);
  if (!proyecto) return null;

  const anteriores = await almacen.leerCitasDeDocumento(proyecto.id);
  const { citados, perdidos } = documento.reubicar(anteriores, parrafos);

  const ficha = {
    nombre: nombre || 'documento.docx',
    subidoAt: new Date().toISOString(),
    parrafos: parrafos.length,
    palabras: parrafos.reduce((suma, p) => suma + p.texto.trim().split(/\s+/).length, 0),
  };
  await almacen.guardarDocumento(proyecto.id, buffer, ficha);
  await almacen.guardarCitasDeDocumento(proyecto.id, citados);

  return { ...ficha, citados: Object.keys(citados).length, perdidos };
}

async function quitar(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  return proyecto ? almacen.borrarDocumento(proyecto.id) : false;
}

/** Lo que enseña el panel. Null si no hay documento. */
async function fichaDelPanel(proyecto) {
  if (!proyecto?.id) return null;
  const ficha = await almacen.leerFichaDeDocumento(proyecto.id).catch(() => null);
  if (!ficha) return null;
  const citados = await almacen.leerCitasDeDocumento(proyecto.id).catch(() => ({}));
  return {
    nombre: ficha.nombre,
    subidoAt: ficha.subidoAt,
    parrafos: ficha.parrafos,
    palabras: ficha.palabras,
    citados: Object.keys(citados).length,
  };
}

/**
 * Una tanda de párrafos para Claude, desde el número `desde`.
 *
 * Los ya citados salen con sus marcas: así, en una conversación nueva, Claude ve
 * por dónde iba en vez de volver a empezar.
 */
async function ver(userId, productCode, { desde = 1 } = {}) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto, buffer } = cargado;
  const ficha = await almacen.leerFichaDeDocumento(proyecto.id);
  const citados = await almacen.leerCitasDeDocumento(proyecto.id);
  const parrafos = documento.leer(buffer);

  const lineas = [];
  let largo = 0;
  let siguiente = null;

  for (const parrafo of parrafos) {
    if (parrafo.id < desde) continue;
    if (largo >= POR_TANDA) {
      siguiente = parrafo.id;
      break;
    }
    const marca = [
      parrafo.nivel ? `[Título ${parrafo.nivel}]` : null,
      parrafo.enTabla ? '[tabla]' : null,
      citados[parrafo.id] ? '[citado]' : null,
    ].filter(Boolean);
    const linea = `¶${parrafo.id}${marca.length ? ` ${marca.join(' ')}` : ''} ${citados[parrafo.id] ?? parrafo.texto}`;
    lineas.push(linea);
    largo += linea.length;
  }

  return {
    nombre: ficha?.nombre ?? 'documento.docx',
    total: parrafos.length,
    primero: parrafos[0]?.id ?? 1,
    ultimo: parrafos.at(-1)?.id ?? 1,
    citados: Object.keys(citados).length,
    lineas,
    siguiente,
    norma: normaDe(proyecto),
  };
}

/**
 * Guarda las marcas de los párrafos que manda Claude.
 *
 * Cada párrafo se acepta o se rechaza por separado, con su motivo: uno con una
 * comilla cambiada no puede tumbar los otros treinta de la misma llamada. Una
 * clave que no es de ninguna fuente suya se rechaza aquí y no al descargar,
 * que es cuando ya nadie está mirando.
 *
 * Un párrafo mandado sin marcas quita las que tenía.
 */
async function citar(userId, productCode, marcados) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto, buffer } = cargado;
  const parrafos = new Map(documento.leer(buffer).map((p) => [p.id, p]));

  const claves = [...new Set(marcados.flatMap((m) => citas.clavesDe(String(m.texto ?? ''))))];
  const fuentes = claves.length > 0 ? await referenceService.porClaves(claves, userId) : [];
  const conocidas = new Set(fuentes.map((f) => f.ref));

  const citados = await almacen.leerCitasDeDocumento(proyecto.id);
  const rechazados = [];
  let guardados = 0;

  for (const { p, texto } of marcados) {
    const parrafo = parrafos.get(Number(p));
    if (!parrafo) {
      rechazados.push({ p, motivo: 'no hay ningún párrafo con ese número' });
      continue;
    }

    const motivo = documento.comprobar(parrafo.texto, texto);
    if (motivo) {
      rechazados.push({ p, motivo });
      continue;
    }

    const desconocidas = citas.clavesDe(texto).filter((clave) => !conocidas.has(clave));
    if (desconocidas.length > 0) {
      rechazados.push({
        p,
        motivo:
          `${desconocidas.join(', ')} no es la clave de ninguna fuente suya ni de la biblioteca de ` +
          'Acosta. Usa solo claves que te haya dado una búsqueda',
      });
      continue;
    }

    if (contarMarcas(texto) + contarFaltas(texto) === 0) delete citados[parrafo.id];
    else citados[parrafo.id] = texto;
    guardados += 1;
  }

  await almacen.guardarCitasDeDocumento(proyecto.id, citados);

  const todos = Object.values(citados);
  return {
    guardados,
    rechazados,
    parrafos: todos.length,
    citas: todos.reduce((suma, t) => suma + contarMarcas(t), 0),
    faltas: todos.reduce((suma, t) => suma + contarFaltas(t), 0),
    norma: normaDe(proyecto),
  };
}

/** «Tesis final (v3).docx» → «tesis-final-v3-con-referencias-2026-09-14.docx». */
function nombreCitado(nombre) {
  const base = String(nombre ?? 'documento')
    .replace(/\.docx$/i, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${base || 'documento'}-con-referencias-${new Date().toISOString().slice(0, 10)}.docx`;
}

/**
 * El Word del tesista con las citas y la lista puestas, en la norma de hoy.
 *
 * Lanza `documento.NormaConNotas` si la norma del proyecto es de notas al pie.
 */
async function armar(userId, productCode) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto, buffer } = cargado;
  const ficha = await almacen.leerFichaDeDocumento(proyecto.id);
  const citados = await almacen.leerCitasDeDocumento(proyecto.id);

  const claves = [...new Set(Object.values(citados).flatMap((t) => citas.clavesDe(t)))];
  const fuentes = claves.length > 0 ? await referenceService.porClaves(claves, userId) : [];

  const hecho = documento.citar(buffer, {
    citados,
    norma: proyecto.estiloCitas,
    idioma: proyecto.idiomaCitas,
    porClave: new Map(fuentes.map((f) => [f.ref, f])),
  });

  return { ...hecho, nombreArchivo: nombreCitado(ficha?.nombre) };
}

/** El enlace para descargarlo desde la conversación. Null si no subió ninguno. */
async function enlace(userId, productCode) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;
  return { ...descarga.enlace({ userId, productCode, que: 'documento' }), norma: normaDe(cargado.proyecto) };
}

/**
 * Una línea para el panorama que lee Claude al empezar, o null si no subió nada.
 *
 * Sin ella, quien sube su tesis y abre una conversación nueva diciendo «ya la
 * subí» se encuentra con un Claude que no sabe de qué le habla.
 */
async function aviso(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  const ficha = await fichaDelPanel(proyecto);
  if (!ficha) return null;
  return (
    `DOCUMENTO SUBIDO PARA CITAR: «${ficha.nombre}», ${ficha.parrafos} párrafos, ` +
    `${ficha.citados} ya con citas. Si pide que lo cites o que le pongas las referencias, ` +
    'empieza con "ver_mi_documento".'
  );
}

module.exports = {
  aviso,
  subir,
  quitar,
  fichaDelPanel,
  ver,
  citar,
  armar,
  enlace,
  nombreCitado,
  POR_TANDA,
};
