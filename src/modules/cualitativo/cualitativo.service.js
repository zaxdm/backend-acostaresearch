'use strict';

/**
 * El análisis cualitativo de un proyecto: las entrevistas y su codificación.
 *
 * Todo va en disco, en la carpeta del proyecto (ver `project.storage`), como el
 * material del curso: dos JSON, uno con las entrevistas ya partidas en párrafos
 * y otro con el libro de códigos y las citas.
 *
 * Las escrituras van de una en una por proyecto: una subida y una codificación a
 * la vez se pisarían.
 */

const projectRepository = require('../projects/project.repository');
const almacen = require('../projects/project.storage');
const { enSerie } = require('../../shared/utils/enSerie');
const lectura = require('./cualitativo.lectura');
const reglas = require('./cualitativo.codificacion');
const tablasCualitativas = require('./cualitativo.tablas');
const redDeCodigos = require('./cualitativo.red');
const citasDelCapitulo = require('./cualitativo.citas');
const exportar = require('./cualitativo.qdpx');

const MAXIMO_ENTREVISTAS = 40;
/** Lo que devuelve «ver» de una vez, en caracteres. */
const POR_TANDA = 12_000;

const clave = (userId, productCode) => `cualitativo:${userId}:${productCode}`;

/** El nombre para enseñar: de una línea y corto. Nunca se usa para escribir en disco. */
function nombreSeguro(nombre) {
  const limpio = String(nombre ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  return limpio || 'entrevista';
}

/** La lista sin el texto: lo que ven la página y Claude. */
function fichas(entrevistas, codificacion) {
  const { porEntrevista } = reglas.resumen(codificacion);
  return (entrevistas ?? []).map((e) => ({
    id: e.id,
    nombre: e.nombre,
    formato: e.formato,
    subidoAt: e.subidoAt,
    parrafos: e.parrafos.length,
    caracteres: e.parrafos.reduce((s, p) => s + p.length, 0),
    citas: porEntrevista[e.id] ?? 0,
  }));
}

/** El proyecto, solo con licencia vigente de ese método. Lo crea si hacía falta. */
async function proyectoConLicencia(userId, productCode) {
  const conLicencia = await projectRepository.productosConLicencia(userId);
  if (!conLicencia.includes(productCode)) return null;
  return (await projectRepository.buscar(userId, productCode)) ?? projectRepository.asegurar(userId, productCode);
}

async function cargar(projectId) {
  const [entrevistas, codificacion] = await Promise.all([
    almacen.leerCualitativo(projectId, 'entrevistas'),
    almacen.leerCualitativo(projectId, 'codificacion'),
  ]);
  return { entrevistas: entrevistas ?? [], codificacion };
}

/** «e3», «E3» o «3» → «E3». */
function idDe(entrevista) {
  const m = /^\s*e?\s*(\d{1,3})\s*$/i.exec(String(entrevista ?? ''));
  return m ? `E${Number(m[1])}` : null;
}

/**
 * Guarda una entrevista. Null si no tiene licencia; lanza `EntrevistaNoValida`
 * si no se puede leer o no cabe.
 *
 * Una con el mismo nombre reemplaza a la anterior y conserva su número (E3
 * sigue siendo E3), pero pierde sus citas: los párrafos pueden haber cambiado y
 * una cita apuntando al párrafo equivocado es peor que ninguna.
 */
function guardar({ userId, productCode, buffer, nombre }) {
  return enSerie(clave(userId, productCode), async () => {
    // Primero se lee: un archivo que no sirve no tiene por qué crear el proyecto.
    const { formato, parrafos } = await lectura.leer(buffer);

    const proyecto = await proyectoConLicencia(userId, productCode);
    if (!proyecto) return null;

    const { entrevistas, codificacion } = await cargar(proyecto.id);
    const limpio = nombreSeguro(nombre);
    const anterior = entrevistas.find((e) => e.nombre === limpio);

    if (!anterior && entrevistas.length >= MAXIMO_ENTREVISTAS) {
      throw new lectura.EntrevistaNoValida(
        `Ya hay ${MAXIMO_ENTREVISTAS} entrevistas subidas. Pídele a Claude que quite alguna antes de subir otra.`,
      );
    }

    const siguiente = entrevistas.reduce((max, e) => Math.max(max, Number(e.id.slice(1))), 0) + 1;
    const entrada = {
      id: anterior?.id ?? `E${siguiente}`,
      nombre: limpio,
      formato,
      subidoAt: new Date().toISOString(),
      parrafos,
    };
    const lista = anterior ? entrevistas.map((e) => (e === anterior ? entrada : e)) : [...entrevistas, entrada];

    await almacen.guardarCualitativo(proyecto.id, 'entrevistas', lista);
    const perdidas = anterior ? (reglas.resumen(codificacion).porEntrevista[anterior.id] ?? 0) : 0;
    if (perdidas > 0) {
      await almacen.guardarCualitativo(proyecto.id, 'codificacion', reglas.sinEntrevista(codificacion, anterior.id));
    }

    return {
      id: entrada.id,
      nombre: entrada.nombre,
      parrafos: parrafos.length,
      reemplazo: Boolean(anterior),
      citasPerdidas: perdidas,
      lista: fichas(lista, perdidas > 0 ? reglas.sinEntrevista(codificacion, anterior.id) : codificacion),
    };
  });
}

/** Lo subido, sin el texto. Vacía si no hay proyecto. */
async function lista(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return [];
  const { entrevistas, codificacion } = await cargar(proyecto.id);
  return fichas(entrevistas, codificacion);
}

/**
 * Los párrafos de una entrevista desde `desde`, hasta llenar una tanda. Null si
 * no existe. `siguiente` es el párrafo por el que seguir, o null si se acabó.
 */
async function ver(userId, productCode, entrevista, { desde = 1 } = {}) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;
  const id = idDe(entrevista);
  const { entrevistas } = await cargar(proyecto.id);
  const elegida = entrevistas.find((e) => e.id === id);
  if (!elegida) return null;

  const total = elegida.parrafos.length;
  const primero = Math.min(Math.max(1, Number(desde) || 1), total);
  const parrafos = [];
  let caracteres = 0;
  for (let n = primero; n <= total; n += 1) {
    const texto = elegida.parrafos[n - 1];
    if (parrafos.length > 0 && caracteres + texto.length > POR_TANDA) break;
    parrafos.push({ numero: n, texto });
    caracteres += texto.length;
  }
  const ultimo = parrafos[parrafos.length - 1].numero;
  return {
    id: elegida.id,
    nombre: elegida.nombre,
    total,
    parrafos,
    siguiente: ultimo < total ? ultimo + 1 : null,
  };
}

/**
 * Guarda la codificación de una entrevista, reemplazando la que tenía. Null si
 * no hay proyecto o no existe la entrevista; lanza `CodificacionNoValida` si
 * alguna cita no está en la entrevista.
 */
function codificar(userId, productCode, entrevista, envio) {
  return enSerie(clave(userId, productCode), async () => {
    const proyecto = await projectRepository.buscar(userId, productCode);
    if (!proyecto) return null;
    const id = idDe(entrevista);
    const { entrevistas, codificacion } = await cargar(proyecto.id);
    const elegida = entrevistas.find((e) => e.id === id);
    if (!elegida) return null;

    const hecho = reglas.codificar(codificacion, elegida, envio);
    await almacen.guardarCualitativo(proyecto.id, 'codificacion', hecho.codificacion);
    return { entrevista: elegida, nuevos: hecho.nuevos, citas: hecho.citas, resumen: reglas.resumen(hecho.codificacion) };
  });
}

/** El libro de códigos con sus cuentas y la lista de entrevistas. */
async function libro(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return { entrevistas: [], resumen: reglas.resumen(null) };
  const { entrevistas, codificacion } = await cargar(proyecto.id);
  return { entrevistas: fichas(entrevistas, codificacion), resumen: reglas.resumen(codificacion) };
}

/** Cambia la codificación guardada con una de las reglas de `cualitativo.codificacion`. */
function cambiarLibro(userId, productCode, cambio) {
  return enSerie(clave(userId, productCode), async () => {
    const proyecto = await projectRepository.buscar(userId, productCode);
    if (!proyecto) return null;
    const { codificacion } = await cargar(proyecto.id);
    const hecho = cambio(codificacion);
    await almacen.guardarCualitativo(proyecto.id, 'codificacion', hecho.codificacion);
    return hecho;
  });
}

const renombrar = (userId, productCode, de, a) =>
  cambiarLibro(userId, productCode, (c) => reglas.renombrar(c, de, a));

const quitarCodigo = (userId, productCode, nombre) =>
  cambiarLibro(userId, productCode, (c) => reglas.quitarCodigo(c, nombre));

/** Quita una entrevista y sus citas. Devuelve su ficha, o null si no existía. */
function quitarEntrevista(userId, productCode, entrevista) {
  return enSerie(clave(userId, productCode), async () => {
    const proyecto = await projectRepository.buscar(userId, productCode);
    if (!proyecto) return null;
    const id = idDe(entrevista);
    const { entrevistas, codificacion } = await cargar(proyecto.id);
    const quitada = entrevistas.find((e) => e.id === id);
    if (!quitada) return null;

    const resto = entrevistas.filter((e) => e !== quitada);
    await almacen.guardarCualitativo(proyecto.id, 'entrevistas', resto.length > 0 ? resto : null);
    if (codificacion) {
      await almacen.guardarCualitativo(proyecto.id, 'codificacion', reglas.sinEntrevista(codificacion, id));
    }
    return { id, nombre: quitada.nombre, citas: reglas.resumen(codificacion).porEntrevista[id] ?? 0 };
  });
}

// ── Lo que sale de la codificación: tablas, red, capítulo y .qdpx ──────────
//
// La red la dibuja R y el Word y el .qdpx se dejan en la carpeta de la sesión
// de R del proyecto, para bajarlos con el mismo enlace que lo que produce R.
// La red se dibuja en una sesión APARTE (`<proyecto>-cual`): las órdenes de R
// se suman al guion de su sesión, y el guion del análisis cuantitativo del
// tesista no tiene por qué llevar la red de sus entrevistas.

const CAPITULO = 'capitulo-cualitativo.docx';
const sesionDeLaRed = (projectId) => `${projectId}-cual`;

class SinMotor extends Error {}

function motor() {
  // Se pide aquí y no arriba: `r.service` carga medio proyecto, y el servicio
  // cualitativo lo usan también la subida y las pruebas, que no lo necesitan.
  const rService = require('../r/r.service');
  return rService.motorActual();
}

async function motorListo() {
  const m = motor();
  if (!m || !(await m.listo())) throw new SinMotor();
  return m;
}

/** Las entrevistas y la codificación del proyecto, o null si no hay nada codificado. */
async function codificado(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;
  const { entrevistas, codificacion } = await cargar(proyecto.id);
  if (!codificacion || codificacion.citas.length === 0) return null;
  return { proyecto, entrevistas, codificacion };
}

/** Las dos tablas en Markdown, listas para el capítulo. Null si no hay nada codificado. */
async function tablas(userId, productCode) {
  const hay = await codificado(userId, productCode);
  if (!hay) return null;
  return {
    frecuencias: tablasCualitativas.tablaDeFrecuencias(hay.entrevistas, hay.codificacion),
    coocurrencia: tablasCualitativas.tablaDeCoocurrencia(hay.codificacion),
    pares: tablasCualitativas.coocurrencias(hay.codificacion).length,
  };
}

/**
 * Dibuja la red con R y la deja en la sesión del proyecto como
 * `red-de-codigos.png`. Null si no hay nada codificado; lanza `SinMotor` si R no
 * está disponible.
 */
async function red(userId, productCode) {
  const hay = await codificado(userId, productCode);
  if (!hay) return null;
  const m = await motorListo();

  const datos = redDeCodigos.datos(hay.entrevistas, hay.codificacion);
  const sesion = sesionDeLaRed(hay.proyecto.id);
  await m.guardarArchivo(sesion, redDeCodigos.NODOS, Buffer.from(datos.nodos, 'utf8'));
  await m.guardarArchivo(sesion, redDeCodigos.ENLACES, Buffer.from(datos.enlaces, 'utf8'));
  const hecho = await m.ejecutar(sesion, redDeCodigos.GUION);
  const figura = hecho.resultado === 'ok' ? await m.leerArchivo(sesion, redDeCodigos.FIGURA) : null;
  if (!figura) return { ...datos, error: String(hecho.salida ?? '').slice(-800) || hecho.resultado };

  await m.guardarArchivo(hay.proyecto.id, redDeCodigos.FIGURA, figura);
  return { ...datos, archivo: redDeCodigos.FIGURA, error: null };
}

/**
 * Arma el Word del capítulo. Antes comprueba cada cita textual contra las
 * entrevistas: si falta alguna, no arma nada y devuelve cuáles.
 */
async function capitulo(userId, productCode, { titulo, texto, norma }) {
  const hay = await codificado(userId, productCode);
  if (!hay) return null;

  const comprobadas = citasDelCapitulo.comprobar(texto, hay.entrevistas, hay.codificacion);
  if (comprobadas.faltan.length > 0) return { comprobadas, faltanFiguras: [], buffer: null };

  const m = await motorListo();
  const rService = require('../r/r.service');
  const informeWord = require('../r/r.informe');

  const figuras = new Map();
  const faltanFiguras = [];
  for (const archivo of informeWord.figurasDe(texto)) {
    const bytes = await m.leerArchivo(hay.proyecto.id, archivo);
    if (bytes && informeWord.dimensionesPng(bytes)) figuras.set(archivo, bytes);
    else faltanFiguras.push(archivo);
  }
  if (faltanFiguras.length > 0) return { comprobadas, faltanFiguras, buffer: null };

  const { buffer, resuelto } = await rService.armarWord({
    userId,
    proyecto: hay.proyecto,
    titulo,
    texto,
    norma,
    figuras,
  });
  await m.guardarArchivo(hay.proyecto.id, CAPITULO, buffer);
  return {
    comprobadas,
    faltanFiguras,
    archivo: CAPITULO,
    tablas: informeWord.cuantasTablas(texto),
    figuras: figuras.size,
    perdidas: resuelto.perdidas,
    norma: resuelto.norma,
  };
}

/** El .qdpx del proyecto, guardado en la sesión. Null si no hay nada codificado. */
async function qdpx(userId, productCode) {
  const hay = await codificado(userId, productCode);
  if (!hay) return null;
  const m = await motorListo();
  const buffer = exportar.armar({
    entrevistas: hay.entrevistas,
    codificacion: hay.codificacion,
    titulo: hay.proyecto.tema || 'Análisis cualitativo',
  });
  await m.guardarArchivo(hay.proyecto.id, exportar.NOMBRE, buffer);
  return {
    archivo: exportar.NOMBRE,
    entrevistas: hay.entrevistas.length,
    codigos: hay.codificacion.codigos.length,
    citas: hay.codificacion.citas.length,
  };
}

module.exports = {
  tablas,
  red,
  capitulo,
  qdpx,
  SinMotor,
  sesionDeLaRed,
  CAPITULO,
  guardar,
  lista,
  ver,
  codificar,
  libro,
  renombrar,
  quitarCodigo,
  quitarEntrevista,
  idDe,
  MAXIMO_ENTREVISTAS,
  POR_TANDA,
};
