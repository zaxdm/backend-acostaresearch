'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ValidationError, ConflictError } = require('../../shared/errors/AppError');
const zotero = require('./zotero.client');
const mapper = require('./zotero.mapper');
const referenceRepository = require('./reference.repository');

/**
 * El corpus bibliográfico de la casa.
 *
 * Dos cosas hace este módulo: traerse la biblioteca de Zotero, y responder a la
 * pregunta «dame fuentes sobre X» que llega desde el conector.
 *
 * QUÉ PROBLEMA RESUELVE
 * ---------------------
 * Un modelo de lenguaje que cita de memoria inventa DOIs. No a veces: es lo que
 * hace cuando no tiene el dato, porque un DOI tiene una forma muy reconocible y
 * completarla es exactamente para lo que sirve. Un DOI inventado en el capítulo
 * II lo comprueba un jurado en diez segundos, y a partir de ahí duda del resto.
 * Con esto, la cita sale de una ficha real que existe de verdad.
 */

/** Cuántas fuentes devuelve una búsqueda del conector si no se pide otra cosa. */
const POR_BUSQUEDA = 6;
const MAXIMO_POR_BUSQUEDA = 15;

/**
 * Lo que NO es una fuente.
 *
 * El guion niega el GRUPO entero, no cada tipo: se escribe `-attachment || note`
 * y significa «ni adjuntos ni notas». Poner el guion dos veces
 * —`-attachment || -note`— es un 400 de Zotero, no una negación doble.
 */
const SOLO_FUENTES = '-attachment || note';

/**
 * Cómo va la sincronización, en memoria.
 *
 * Vive en el proceso y no en la base a propósito: es información de una tarea en
 * curso, no un dato del negocio, y si el servidor se reinicia a media pasada lo
 * correcto es que desaparezca. Volver a pulsar el botón retoma desde la misma
 * versión, porque cada fila se escribe con `ON DUPLICATE KEY`: repetir una
 * pasada no duplica nada.
 */
const trabajo = {
  activo: false,
  fase: null,
  hechas: 0,
  total: 0,
  guardadas: 0,
  notas: 0,
  retiradas: 0,
  empezado: null,
  terminado: null,
  error: null,
};

function exigirConfiguracion() {
  if (!env.zoteroEnabled) {
    throw new ValidationError(
      'El corpus bibliográfico no está configurado: falta ZOTERO_API_KEY o la biblioteca.',
    );
  }
}

/**
 * Primera pasada: las fuentes.
 *
 * Se escriben por lotes según van llegando las páginas, sin juntarlas antes. Con
 * 24.000 fuentes, acumularlas para guardarlas al final son cientos de megas de
 * objetos en memoria y un proceso muerto en un VPS pequeño.
 */
async function traerFuentes(desdeVersion) {
  let versionBiblioteca = desdeVersion;
  let pendientes = [];
  let gruposPendientes = {};

  const volcar = async () => {
    if (pendientes.length === 0) return;
    trabajo.guardadas += await referenceRepository.guardarLote(pendientes);
    await referenceRepository.escribirGrupos(gruposPendientes);
    pendientes = [];
    gruposPendientes = {};
  };

  for await (const pagina of zotero.paginasDeItems({
    desdeVersion,
    itemType: SOLO_FUENTES,
    alAvanzar: (hechas, total) => {
      trabajo.hechas = hechas;
      trabajo.total = total;
    },
  })) {
    if (pagina.versionBiblioteca) versionBiblioteca = pagina.versionBiblioteca;

    for (const item of pagina.items) {
      if (!mapper.esFuente(item)) continue;
      const { fila, etiquetas } = mapper.aFila(item);
      pendientes.push(fila);

      // Solo las etiquetadas cuestan una relectura después. Casi ninguna lo está.
      const productos = referenceRepository.gruposDeEtiquetas(etiquetas);
      if (productos.length > 0) gruposPendientes[fila.zoteroKey] = productos;
    }

    if (pendientes.length >= referenceRepository.POR_LOTE) await volcar();
  }

  await volcar();
  return versionBiblioteca;
}

/**
 * Segunda pasada: las notas.
 *
 * Van aparte y no junto a su fuente porque una nota es un ítem hijo con su
 * propia clave, y al recorrer la biblioteca por páginas no hay ninguna garantía
 * de que caiga en la misma página que su padre. Traerlas después, cuando las
 * fuentes ya están escritas, es lo único que funciona sin guardarlo todo en
 * memoria primero.
 */
async function traerNotas(desdeVersion) {
  for await (const pagina of zotero.paginasDeItems({
    desdeVersion,
    itemType: 'note',
    alAvanzar: (hechas, total) => {
      trabajo.hechas = hechas;
      trabajo.total = total;
    },
  })) {
    const porPadre = {};

    for (const item of pagina.items) {
      if (!mapper.esNota(item)) continue;
      const texto = mapper.textoPlano(item.data.note);
      if (!texto) continue;
      // La inmensa mayoría de las notas de esta biblioteca no son notas: son la
      // ficha administrativa que Scopus adjunta al exportar. Ver el detector.
      if (mapper.esPapeleoDeScopus(texto)) continue;
      const padre = item.data.parentItem;
      (porPadre[padre] ??= []).push(texto);
    }

    trabajo.notas += await referenceRepository.aplicarNotas(porPadre);
  }
}

/** El trabajo de verdad. Se llama sin esperarlo: puede durar minutos. */
async function correr({ completa }) {
  try {
    const estado = await referenceRepository.estadoSync();
    const desde = completa ? 0 : estado.libraryVersion;

    trabajo.fase = 'fuentes';
    const versionBiblioteca = await traerFuentes(desde);

    trabajo.fase = 'notas';
    trabajo.hechas = 0;
    await traerNotas(desde);

    // Lo borrado en Zotero tiene que desaparecer aquí. Si no, una fuente
    // retirada —porque resultó ser de una revista depredadora, porque estaba
    // mal— se seguiría citando para siempre.
    trabajo.fase = 'retiradas';
    const borradas = await zotero.listarBorrados(desde);
    const { count } = await referenceRepository.borrarPorClaves(borradas);
    trabajo.retiradas = count;

    const total = await referenceRepository.contar();
    await referenceRepository.guardarSync({ libraryVersion: versionBiblioteca, lastCount: total });

    logger.info(
      {
        desde,
        hasta: versionBiblioteca,
        guardadas: trabajo.guardadas,
        notas: trabajo.notas,
        retiradas: trabajo.retiradas,
        total,
      },
      'Corpus bibliográfico sincronizado desde Zotero',
    );
  } catch (fallo) {
    trabajo.error = fallo.message;
    logger.error({ err: fallo }, 'Falló la sincronización con Zotero');
  } finally {
    trabajo.activo = false;
    trabajo.fase = null;
    trabajo.terminado = new Date();
  }
}

/**
 * Arranca la sincronización y vuelve enseguida.
 *
 * No espera a que termine porque no puede: la primera pasada son unas
 * cuatrocientas peticiones a Zotero y varios minutos, y ninguna petición HTTP
 * sobrevive a eso —ni el proxy de delante, ni el navegador—. El panel pregunta
 * por el estado cada pocos segundos.
 */
function sincronizar({ completa = false } = {}) {
  exigirConfiguracion();

  if (trabajo.activo) {
    throw new ConflictError('Ya hay una sincronización en marcha. Espera a que termine.');
  }

  Object.assign(trabajo, {
    activo: true,
    fase: 'empezando',
    hechas: 0,
    total: 0,
    guardadas: 0,
    notas: 0,
    retiradas: 0,
    empezado: new Date(),
    terminado: null,
    error: null,
  });

  correr({ completa });

  return { ...trabajo, completa };
}

/** Estado para el panel, sin llamar a Zotero. */
async function estado() {
  const [marcador, total] = await Promise.all([
    referenceRepository.estadoSync(),
    referenceRepository.contar(),
  ]);

  return {
    configurado: env.zoteroEnabled,
    biblioteca: env.zoteroLibrary,
    total,
    libraryVersion: marcador.libraryVersion,
    lastRunAt: marcador.lastRunAt,
    trabajo: { ...trabajo },
  };
}

/**
 * La cita en APA, armada de campos separados.
 *
 * Se compone aquí y no en el asistente a propósito: el asistente tiene los
 * datos y sabría formatearlos, pero formatear de memoria es justo donde se
 * cuelan el año que no era y el DOI que no existe.
 */
function cita(fuente) {
  const partes = [];
  partes.push(fuente.authors || '(Autor no consignado)');
  partes.push(`(${fuente.year ?? 's. f.'}).`);
  partes.push(`${fuente.title}.`);
  if (fuente.source) partes.push(`${fuente.source}.`);
  if (fuente.doi) partes.push(`https://doi.org/${fuente.doi}`);
  else if (fuente.url) partes.push(fuente.url);
  return partes.join(' ');
}

/**
 * Busca fuentes para una licencia.
 *
 * Las palabras de una o dos letras se descartan: «de», «la» y «el» aparecen en
 * todas las fichas, así que exigirlas no filtra nada y en cambio dejan fuera una
 * fuente cuyo título las escribió de otro modo.
 */
async function buscarParaLicencia({ tema, productCode, cuantas }) {
  const palabras = mapper
    .normalizar(tema)
    .split(/[^a-z0-9]+/)
    .filter((palabra) => palabra.length > 2);

  if (palabras.length === 0) {
    throw new ValidationError('Dime sobre qué tema buscar, con al menos una palabra.');
  }

  const limite = Math.min(Math.max(Number(cuantas) || POR_BUSQUEDA, 1), MAXIMO_POR_BUSQUEDA);
  const fuentes = await referenceRepository.buscar({ palabras, productCode, limite });

  return fuentes.map((fuente) => ({
    titulo: fuente.title,
    cita: cita(fuente),
    doi: fuente.doi,
    url: fuente.url,
    anio: fuente.year,
    resumen: fuente.abstract,
    nota: fuente.notes,
    etiquetas: fuente.tags,
  }));
}

const listarParaPanel = (opciones) => referenceRepository.listarParaPanel(opciones);

module.exports = { sincronizar, estado, buscarParaLicencia, listarParaPanel, cita };
