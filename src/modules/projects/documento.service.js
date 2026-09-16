'use strict';

/**
 * El Word que subió el tesista, para citarlo o para humanizarlo: lo que junta el
 * archivo, sus fuentes, lo reescrito y la norma del proyecto. Cómo se escriben
 * las citas dentro del Word está en `project.documento`, y los párrafos
 * humanizados en `project.reescritura`.
 *
 * EL RECORRIDO
 * ------------
 * 1. El tesista sube su .docx desde el panel. Se guarda entero.
 * 2. En la conversación, Claude lo lee por párrafos (`ver`), busca fuentes y le
 *    enseña un resumen antes de tocar nada.
 * 3. Con su visto bueno, manda los párrafos con las marcas puestas (`citar`).
 *    Solo se guardan las marcas: el Word no se toca hasta que se descarga.
 * 4. Para humanizarlo, Claude manda los párrafos reescritos (`humanizar`), con
 *    el visto bueno del tesista. Se guarda el texto nuevo junto al original.
 * 5. Cada descarga (`armar`) escribe primero los párrafos humanizados y después
 *    pone las citas en la norma que tenga el proyecto en ese momento. Cambiar de
 *    norma no obliga a volver a citar, y el Word subido nunca se sobrescribe.
 */

const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const documento = require('./project.documento');
const reescritura = require('./project.reescritura');
const normas = require('./project.normas');
const citas = require('./project.citas');
const descarga = require('./project.descarga');
const referenceService = require('../references/reference.service');
const { enSerie } = require('../../shared/utils/enSerie');

/** Caracteres de texto por cada respuesta de `ver`: lo que cabe holgado en una llamada del conector. */
const POR_TANDA = 24000;

/**
 * Subir, citar y quitar el documento van de uno en uno por proyecto. Las citas
 * se leen, se fusionan y se escriben: dos tandas a la vez leían las dos lo de
 * antes, y la segunda borraba las marcas de la primera.
 */
const claveDelDocumento = (userId, productCode) => `documento:${userId}:${productCode}`;

const contarMarcas = (texto) => [...String(texto).matchAll(citas.MARCA)].length;
const contarFaltas = (texto) => String(texto).match(documento.FALTA)?.length ?? 0;

/** Las marcas de un párrafo, ordenadas, para comparar las de antes con las de después. */
const marcasDe = (texto) =>
  [
    ...[...String(texto ?? '').matchAll(citas.MARCA)].map((m) => m[0]),
    ...Array.from({ length: contarFaltas(texto ?? '') }, () => '[FALTA FUENTE]'),
  ].sort();

/**
 * El texto sin las marcas y sin el espacio que llevan delante: «crece [AR…].» es
 * «crece.», y así se escribe en el Word antes de poner la cita con su espacio.
 */
const quitarMarcas = (texto) =>
  String(texto)
    .replace(/[ \t]*\[AR[0-9A-F]{8}(?::[^\]\n]{1,40})?\]/g, '')
    .replace(/[ \t]*\[FALTA FUENTE\]/gi, '');

/** Lo que Claude ve y lo que se compara: lo humanizado si lo hay, y si no, lo del Word. */
const textoVigente = (parrafo, reescritos) => reescritos[parrafo.id]?.texto ?? parrafo.texto;

/** Rótulos y notas de tabla o figura: «Tabla 3», «Figura 1», «Nota. Elaboración propia». No se humanizan. */
const ROTULO = /^((tabla|figura|gr[aá]fico|cuadro|ilustraci[oó]n)\s+\d+|nota\.\s)/i;

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
function subir(argumentos) {
  return enSerie(claveDelDocumento(argumentos.userId, argumentos.productCode), () => subirEnSuTurno(argumentos));
}

async function subirEnSuTurno({ userId, productCode, buffer, nombre }) {
  const parrafos = documento.leer(buffer);
  if (parrafos.length === 0) {
    throw new documento.DocumentoNoValido('Ese documento no tiene texto que citar.');
  }

  const proyecto = await proyectoConLicencia(userId, productCode);
  if (!proyecto) return null;

  // Primero lo humanizado, porque las citas de un párrafo humanizado van sobre su texto nuevo.
  const { reescritos, perdidos: humanizadosPerdidos } = reubicarReescritos(
    await almacen.leerReescritosDeDocumento(proyecto.id),
    parrafos,
  );
  const vigentes = parrafos.map((p) => ({ ...p, texto: textoVigente(p, reescritos) }));
  const anteriores = await almacen.leerCitasDeDocumento(proyecto.id);
  const { citados, perdidos } = documento.reubicar(anteriores, vigentes);

  const ficha = {
    nombre: nombre || 'documento.docx',
    subidoAt: new Date().toISOString(),
    parrafos: parrafos.length,
    palabras: parrafos.reduce((suma, p) => suma + p.texto.trim().split(/\s+/).length, 0),
  };
  await almacen.guardarDocumento(proyecto.id, buffer, ficha);
  await almacen.guardarCitasDeDocumento(proyecto.id, citados);
  await almacen.guardarReescritosDeDocumento(proyecto.id, reescritos);

  return {
    ...ficha,
    citados: Object.keys(citados).length,
    perdidos,
    humanizados: Object.keys(reescritos).length,
    humanizadosPerdidos,
  };
}

/**
 * Los párrafos humanizados de un Word anterior, en el Word nuevo.
 *
 * Cada uno se busca por su texto original. Si en el Word nuevo ya está el texto
 * humanizado —porque el tesista descargó el revisado y lo volvió a subir—, ya
 * no hace falta y no cuenta como perdido.
 */
function reubicarReescritos(anteriores, parrafos) {
  const porEsqueleto = new Map();
  for (const parrafo of parrafos) {
    const clave = documento.esqueleto(parrafo.texto);
    if (!porEsqueleto.has(clave)) porEsqueleto.set(clave, []);
    porEsqueleto.get(clave).push(parrafo.id);
  }

  const usados = new Set();
  const reescritos = {};
  let perdidos = 0;

  for (const [id, entrada] of Object.entries(anteriores ?? {})) {
    const candidatos = (porEsqueleto.get(documento.esqueleto(entrada.original)) ?? []).filter((c) => !usados.has(c));
    if (candidatos.length === 0) {
      const yaPuesto = reescritura.partesDe(entrada.texto).every((parte) => porEsqueleto.has(documento.esqueleto(parte)));
      if (!yaPuesto) perdidos += 1;
      continue;
    }
    const elegido = candidatos.reduce((mejor, c) =>
      Math.abs(c - Number(id)) < Math.abs(mejor - Number(id)) ? c : mejor,
    );
    usados.add(elegido);
    reescritos[elegido] = entrada;
  }

  return { reescritos, perdidos };
}

function quitar(userId, productCode) {
  return enSerie(claveDelDocumento(userId, productCode), () => quitarEnSuTurno(userId, productCode));
}

async function quitarEnSuTurno(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  return proyecto ? almacen.borrarDocumento(proyecto.id) : false;
}

/** Lo que enseña el panel. Null si no hay documento. */
async function fichaDelPanel(proyecto) {
  if (!proyecto?.id) return null;
  const ficha = await almacen.leerFichaDeDocumento(proyecto.id).catch(() => null);
  if (!ficha) return null;
  const citados = await almacen.leerCitasDeDocumento(proyecto.id).catch(() => ({}));
  const reescritos = await almacen.leerReescritosDeDocumento(proyecto.id).catch(() => ({}));
  return {
    nombre: ficha.nombre,
    subidoAt: ficha.subidoAt,
    parrafos: ficha.parrafos,
    palabras: ficha.palabras,
    citados: Object.keys(citados).length,
    humanizados: Object.keys(reescritos).length,
  };
}

/** La ficha del documento subido sin leer el Word: para decir cuál hay. Null si no hay. */
async function fichaDe(userId, productCode) {
  return fichaDelPanel(await projectRepository.buscar(userId, productCode));
}

/**
 * Una tanda de párrafos para Claude, desde el número `desde`.
 *
 * Los ya citados salen con sus marcas y los humanizados con su texto nuevo: así,
 * en una conversación nueva, Claude ve por dónde iba en vez de volver a empezar,
 * y la segunda ronda del humanizador audita lo que escribió la primera. Un
 * párrafo partido en dos sale con [APARTE] donde va el corte.
 */
async function ver(userId, productCode, { desde = 1 } = {}) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto, buffer } = cargado;
  const ficha = await almacen.leerFichaDeDocumento(proyecto.id);
  const citados = await almacen.leerCitasDeDocumento(proyecto.id);
  const reescritos = await almacen.leerReescritosDeDocumento(proyecto.id);
  const parrafos = documento.leer(buffer);
  const bloqueados = reescritura.bloqueados(buffer);

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
      parrafo.referencias ? '[referencias]' : null,
      reescritos[parrafo.id] ? '[humanizado]' : null,
      citados[parrafo.id] ? '[citado]' : null,
      bloqueados.has(parrafo.id) && !parrafo.nivel && !parrafo.enTabla ? '[no se reescribe]' : null,
    ].filter(Boolean);
    const vigente = (citados[parrafo.id] ?? textoVigente(parrafo, reescritos)).replace(/\s*\n\s*\n\s*/g, ' [APARTE] ');
    const linea = `¶${parrafo.id}${marca.length ? ` ${marca.join(' ')}` : ''} ${vigente}`;
    lineas.push(linea);
    largo += linea.length;
  }

  return {
    nombre: ficha?.nombre ?? 'documento.docx',
    subidoAt: ficha?.subidoAt ?? null,
    total: parrafos.length,
    primero: parrafos[0]?.id ?? 1,
    ultimo: parrafos.at(-1)?.id ?? 1,
    citados: Object.keys(citados).length,
    humanizados: Object.keys(reescritos).length,
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
function citar(userId, productCode, marcados) {
  return enSerie(claveDelDocumento(userId, productCode), () => citarEnSuTurno(userId, productCode, marcados));
}

async function citarEnSuTurno(userId, productCode, marcados) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto, buffer } = cargado;
  const parrafos = new Map(documento.leer(buffer).map((p) => [p.id, p]));
  const reescritos = await almacen.leerReescritosDeDocumento(proyecto.id);

  const claves = [...new Set(marcados.flatMap((m) => citas.clavesDe(String(m.texto ?? ''))))];
  const fuentes = claves.length > 0 ? await referenceService.porClaves(claves, userId) : [];
  const conocidas = new Set(fuentes.map((f) => f.ref));

  const citados = await almacen.leerCitasDeDocumento(proyecto.id);
  const rechazados = [];
  let guardados = 0;

  for (const { p, texto: tal } of marcados) {
    const parrafo = parrafos.get(Number(p));
    if (!parrafo) {
      rechazados.push({ p, motivo: 'no hay ningún párrafo con ese número' });
      continue;
    }

    // Si está humanizado, las marcas van sobre su texto nuevo, con sus partes.
    const texto = reescritura.conApartes(tal);
    const motivo = documento.comprobar(textoVigente(parrafo, reescritos), texto);
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

/**
 * Guarda los párrafos que humanizó Claude, con el visto bueno del tesista.
 *
 * Cada uno se acepta o se rechaza por separado y con su motivo, como las citas.
 * Se compara SIEMPRE con el texto del Word, no con la ronda anterior: tres
 * rondas no pueden ir alejando las cifras o los apellidos poco a poco.
 *
 * Un párrafo citado tiene que traer las mismas marcas, cada una con su
 * afirmación; uno sin citas no puede traer marcas nuevas, que es trabajo de
 * `citar`. Mandar el texto del Word tal cual, o pedirlo en `deshacer`, lo
 * devuelve a como estaba.
 */
function humanizar(userId, productCode, cambios, deshacer) {
  return enSerie(claveDelDocumento(userId, productCode), () =>
    humanizarEnSuTurno(userId, productCode, cambios ?? [], deshacer ?? []),
  );
}

async function humanizarEnSuTurno(userId, productCode, cambios, deshacer) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto, buffer } = cargado;
  const parrafos = new Map(documento.leer(buffer).map((p) => [p.id, p]));
  const reescritos = await almacen.leerReescritosDeDocumento(proyecto.id);
  const citados = await almacen.leerCitasDeDocumento(proyecto.id);
  const probar = reescritura.probador(buffer);

  const rechazados = [];
  const avisos = [];
  let guardados = 0;
  let deshechos = 0;

  for (const p of deshacer) {
    const id = Number(p);
    if (!reescritos[id]) {
      rechazados.push({ p, motivo: 'no estaba humanizado' });
      continue;
    }
    // Sus citas se guardaron sobre el texto nuevo y en el original no caben.
    if (citados[id] && documento.comprobar(parrafos.get(id)?.texto ?? '', citados[id]) !== null) {
      rechazados.push({
        p,
        motivo:
          'tiene citas puestas sobre el texto humanizado: para devolverlo al original, mándalo en ' +
          '"parrafos" con el texto del Word tal cual y las marcas en su sitio',
      });
      continue;
    }
    delete reescritos[id];
    deshechos += 1;
  }

  for (const { p, texto: tal } of cambios) {
    const id = Number(p);
    const parrafo = parrafos.get(id);
    const rechazar = (motivo) => rechazados.push({ p, motivo });

    if (!parrafo) {
      rechazar('no hay ningún párrafo con texto con ese número');
      continue;
    }
    if (parrafo.nivel) {
      rechazar('es un título: los títulos no se humanizan');
      continue;
    }
    if (parrafo.enTabla) {
      rechazar('está dentro de una tabla: las tablas no se tocan');
      continue;
    }
    if (parrafo.referencias) {
      rechazar('está en la lista de referencias, que no se humaniza');
      continue;
    }
    if (ROTULO.test(parrafo.texto.trim())) {
      rechazar('es el rótulo o la nota de una tabla o de una figura, que no se humaniza');
      continue;
    }

    const texto = reescritura.conApartes(tal);
    const antes = marcasDe(citados[id]);
    const despues = marcasDe(texto);
    if (antes.join(' ') !== despues.join(' ')) {
      rechazar(
        antes.length > 0
          ? `el párrafo lleva las marcas ${antes.join(' ')} y el texto nuevo trae ` +
              `${despues.join(' ') || 'ninguna'}: cada marca viaja con su afirmación, sin borrarla ni añadir otra`
          : 'trae marcas de cita y el párrafo no tenía ninguna: para citar, usa "citar_mi_documento"',
      );
      continue;
    }

    const limpio = quitarMarcas(texto);
    const comoElOriginal =
      reescritura.partesDe(limpio).length === 1 && documento.esqueleto(limpio) === documento.esqueleto(parrafo.texto);

    if (comoElOriginal) {
      if (reescritos[id]) {
        delete reescritos[id];
        deshechos += 1;
      }
      if (antes.length > 0) citados[id] = texto;
      guardados += 1;
      continue;
    }

    const motivo = reescritura.comprobarReescritura(parrafo.texto, limpio);
    if (motivo) {
      rechazar(motivo);
      continue;
    }

    const prueba = probar(id, limpio);
    if (prueba.motivo) {
      rechazar(`${prueba.motivo}: ese párrafo lo tiene que cambiar el tesista en su Word`);
      continue;
    }

    reescritos[id] = { original: parrafo.texto, texto: limpio };
    if (antes.length > 0) citados[id] = texto;
    guardados += 1;
    if (prueba.notas) {
      avisos.push(`¶${id} tiene llamadas a nota al pie: que compruebe en su Word que siguen detrás de la palabra correcta`);
    }
  }

  await almacen.guardarReescritosDeDocumento(proyecto.id, reescritos);
  await almacen.guardarCitasDeDocumento(proyecto.id, citados);

  const todos = Object.values(reescritos);
  return {
    guardados,
    deshechos,
    rechazados,
    avisos,
    humanizados: todos.length,
    partidos: todos.filter((r) => reescritura.partesDe(r.texto).length > 1).length,
  };
}

/**
 * Las citas, con los números de párrafo del Word ya humanizado.
 *
 * Partir un párrafo en dos corre un puesto todos los de detrás. Y las marcas del
 * párrafo partido se reparten entre sus partes por caracteres visibles: una
 * marca pegada al final de la primera parte se queda en la primera.
 */
function recolocarCitas(citados, partes, reescritos) {
  const partidos = Object.keys(partes)
    .map(Number)
    .filter((id) => partes[id] > 1)
    .sort((a, b) => a - b);
  const corrimiento = (id) => partidos.filter((x) => x < id).reduce((suma, x) => suma + partes[x] - 1, 0);

  const nuevos = {};
  for (const [id, texto] of Object.entries(citados)) {
    const n = Number(id);
    const destino = n + corrimiento(n);
    if (!(partes[n] > 1)) {
      nuevos[destino] = texto;
      continue;
    }
    const largos = reescritura.partesDe(reescritos[n].texto).map((parte) => documento.esqueleto(parte).length);
    partirCitado(texto, largos).forEach((trozo, i) => {
      if (contarMarcas(trozo) + contarFaltas(trozo) > 0) nuevos[destino + i] = trozo;
    });
  }
  return nuevos;
}

const MARCA_AQUI = /\[AR[0-9A-F]{8}(?::[^\]\n]{1,40})?\]|\[FALTA FUENTE\]/iy;

/** Un párrafo con marcas, en trozos de `largos` caracteres visibles cada uno. */
function partirCitado(texto, largos) {
  const trozos = [];
  let actual = '';
  let cuenta = 0;
  let i = 0;

  while (i < texto.length) {
    MARCA_AQUI.lastIndex = i;
    const marca = MARCA_AQUI.exec(texto);
    if (marca) {
      actual += marca[0];
      i += marca[0].length;
      continue;
    }
    const caracter = String.fromCodePoint(texto.codePointAt(i));
    if (!/\s/.test(caracter)) {
      if (trozos.length < largos.length - 1 && cuenta >= largos[trozos.length]) {
        trozos.push(actual.trim());
        actual = '';
        cuenta = 0;
      }
      cuenta += 1;
    }
    actual += caracter;
    i += caracter.length;
  }
  trozos.push(actual.trim());
  return trozos;
}

/** «Tesis final (v3).docx» → «tesis-final-v3-con-referencias-2026-09-14.docx». */
function nombreCitado(nombre, sufijo = 'con-referencias') {
  const base = String(nombre ?? 'documento')
    .replace(/\.docx$/i, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${base || 'documento'}-${sufijo}-${new Date().toISOString().slice(0, 10)}.docx`;
}

/**
 * El Word del tesista con lo humanizado, las citas y la lista puestas, en la norma de hoy.
 *
 * Lanza `documento.NormaConNotas` si hay citas y la norma del proyecto es de
 * notas al pie. Si solo se humanizó, la norma no importa.
 */
async function armar(userId, productCode) {
  const cargado = await cargar(userId, productCode);
  if (!cargado) return null;

  const { proyecto } = cargado;
  const ficha = await almacen.leerFichaDeDocumento(proyecto.id);
  const reescritos = await almacen.leerReescritosDeDocumento(proyecto.id);
  let citados = await almacen.leerCitasDeDocumento(proyecto.id);
  let { buffer } = cargado;
  let humanizados = 0;

  if (Object.keys(reescritos).length > 0) {
    const hecho = reescritura.reescribir(buffer, reescritos);
    buffer = hecho.buffer;
    humanizados = Object.keys(hecho.partes).length;
    citados = recolocarCitas(citados, hecho.partes, reescritos);
  }

  if (humanizados > 0 && Object.keys(citados).length === 0) {
    return {
      buffer,
      parrafos: 0,
      citas: 0,
      referencias: 0,
      faltas: 0,
      perdidas: 0,
      humanizados,
      nombreArchivo: nombreCitado(ficha?.nombre, 'revisado'),
    };
  }

  const claves = [...new Set(Object.values(citados).flatMap((t) => citas.clavesDe(t)))];
  const fuentes = claves.length > 0 ? await referenceService.porClaves(claves, userId) : [];

  const hecho = documento.citar(buffer, {
    citados,
    norma: proyecto.estiloCitas,
    idioma: proyecto.idiomaCitas,
    porClave: new Map(fuentes.map((f) => [f.ref, f])),
  });

  return { ...hecho, humanizados, nombreArchivo: nombreCitado(ficha?.nombre) };
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
    `DOCUMENTO SUBIDO: «${ficha.nombre}», ${ficha.parrafos} párrafos, ${ficha.citados} ya con citas y ` +
    `${ficha.humanizados} humanizados. Si pide que lo cites, que le pongas las referencias o que lo ` +
    'humanices, empieza con "ver_mi_documento": se trabaja sobre ese Word, no sobre una copia.'
  );
}

module.exports = {
  aviso,
  subir,
  quitar,
  fichaDelPanel,
  fichaDe,
  ver,
  citar,
  humanizar,
  armar,
  enlace,
  nombreCitado,
  partirCitado,
  POR_TANDA,
};
