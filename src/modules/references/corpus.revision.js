'use strict';

/**
 * El corpus de una revisión, armado desde la conversación: la herramienta
 * "armar_corpus_de_busqueda" del conector.
 *
 * PARA QUÉ
 * --------
 * En la Fase 3 de la ruta de revisión el tesista tenía una sola vía: entrar a
 * cada base, exportar y subir los archivos. Esta es la segunda: corre la
 * búsqueda aquí, en Scopus (la clave de la casa), en OpenAlex, en SciELO (por
 * OpenAlex) y en las bases abiertas de `externas`, y deja por base el archivo
 * que lee el script del cribado (`corpus.py`) más un RIS con todo para su
 * Zotero o su Mendeley.
 *
 * LOS FORMATOS
 * ------------
 * · Scopus, OpenAlex y SciELO: el CSV de OpenAlex de `scopus.mapeo`
 *   (`csvDeOpenAlex`), el mismo que bibliometrix lee con `dbsource =
 *   "openalex"` —probado el 21-sep-2026— y que `corpus.py` reconoce por sus
 *   columnas. Lleva autores con país e institución, palabras clave, resumen y
 *   referencias citadas, así que el corte para la Fase 3B sale de aquí mismo.
 * · Las demás bases: RIS con resumen. bibliometrix no lo lee; va a la síntesis.
 * · `_todo.ris`: todo junto y sin repetir el mismo DOI, para el gestor de
 *   referencias. Los duplicados del PRISMA NO se quitan aquí: los cuenta
 *   `corpus.py identificar`, que es quien los declara.
 * · `_registro.txt`: fecha, ecuación o filtro literal de cada base y cuántos
 *   había y cuántos se bajaron. Es la hoja «Búsqueda» del PRISMA.
 *
 * DE SCOPUS, SOLO LOS DOI
 * -----------------------
 * Mismo criterio que el mapeo bibliométrico: la vista STANDARD no trae
 * resumen, ni todos los autores, ni palabras clave, y los datos de Scopus no
 * se guardan ni se reparten. De Scopus se toma la lista de DOI de la búsqueda;
 * lo demás llega de OpenAlex. Los registros de Scopus sin DOI o que OpenAlex no
 * conoce no entran al archivo, y se dice cuántos son: quien los necesite
 * exporta de Scopus (la primera vía).
 */

const logger = require('../../config/logger');
const { ValidationError } = require('../../shared/errors/AppError');
const openalex = require('./openalex.client');
const mapeo = require('../scopus/scopus.mapeo');
const externas = require('../externas');

/** Cuántos se bajan por base si no se dice otra cosa, y el techo. */
const POR_DEFECTO = 500;
const TOPE_POR_BASE = openalex.TOPE_DEL_CORPUS;

/**
 * Cuánto puede durar como mucho, para todas las bases juntas.
 *
 * Esto pasa dentro de un turno de conversación. Si una base va lenta, se corta
 * con lo que haya y se dice: un corpus a medias con el aviso es mejor que una
 * herramienta que no vuelve nunca.
 */
const PLAZO_MS = 150_000;

/** Las bases que se pueden pedir, además de las de `externas`. */
const PROPIAS = Object.freeze({
  scopus: 'Scopus',
  openalex: 'OpenAlex',
  scielo: 'SciELO',
});

/** Qué se pide en OpenAlex si el tesista quiere solo artículos. */
const TIPOS_ARTICULO = ['article', 'review'];

function nombreDe(clave) {
  return PROPIAS[clave] ?? externas.base(clave)?.nombre ?? clave;
}

/** La palabra del tema, apta para nombre de archivo. */
function claveSegura(clave) {
  const limpia = String(clave ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return limpia || 'revision';
}

/** La consulta sin operadores, para las bases que solo entienden palabras. */
function palabrasDe(consulta) {
  return String(consulta ?? '')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/[()"*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── RIS ─────────────────────────────────────────────────────────────────────

/** Un valor en una línea de RIS: sin saltos, que cortarían el registro. */
function linea(etiqueta, valor) {
  const v = String(valor ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return v ? `${etiqueta}  - ${v}` : null;
}

const TIPOS_RIS = {
  article: 'JOUR',
  review: 'JOUR',
  dissertation: 'THES',
  book: 'BOOK',
  'book-chapter': 'CHAP',
  chapter: 'CHAP',
  preprint: 'UNPB',
};

/**
 * «Pérez, J. A., García, M., & López, A.» → los tres autores.
 *
 * Así llegan los autores de las bases de `externas` (`comun.autoresApa`). Se
 * corta en la coma que sigue a una inicial, que es la única que separa
 * personas: la de dentro («Pérez, J.») va después del apellido.
 */
function autoresDeApa(texto) {
  return String(texto ?? '')
    .split(/(?<=\.)\s*,\s*(?:&\s*)?|\s+&\s+/)
    .map((a) => a.trim())
    .filter((a) => a && !/^\(?autor no consignado\)?$/i.test(a));
}

/** Un registro en RIS. `r` es la forma común de abajo (`deOpenAlex`, `deExterna`). */
function registroRis(r) {
  return [
    `TY  - ${TIPOS_RIS[r.tipo] ?? 'JOUR'}`,
    linea('TI', r.titulo),
    ...r.autores.map((a) => linea('AU', a)),
    linea('PY', r.anio),
    linea('T2', r.revista),
    linea('VL', r.volumen),
    linea('IS', r.numero),
    linea('SP', r.paginaInicio),
    linea('EP', r.paginaFin),
    linea('DO', r.doi),
    linea('UR', r.url),
    linea('LA', r.idioma),
    linea('AB', r.resumen),
    ...r.palabras.map((k) => linea('KW', k)),
    linea('DB', r.base),
    linea('N1', r.tipo ? `Tipo de documento: ${r.tipo}` : null),
    'ER  - ',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function ris(registros) {
  return `${registros.map(registroRis).join('\r\n\r\n')}\r\n`;
}

// ── Una forma común ─────────────────────────────────────────────────────────

/** Una obra de OpenAlex (con `CAMPOS_BIBLIOMETRICOS`) en la forma común. */
function deOpenAlex(w, base) {
  return {
    base,
    titulo: w.display_name ?? w.title ?? '',
    autores: (w.authorships ?? []).map((a) => a?.author?.display_name).filter(Boolean),
    anio: w.publication_year ?? null,
    revista: w.primary_location?.source?.display_name ?? null,
    volumen: w.biblio?.volume ?? null,
    numero: w.biblio?.issue ?? null,
    paginaInicio: w.biblio?.first_page ?? null,
    paginaFin: w.biblio?.last_page ?? null,
    doi: openalex.limpiarDoi(w.doi),
    url: w.primary_location?.landing_page_url ?? w.doi ?? null,
    idioma: w.language ?? null,
    resumen: openalex.resumenDelIndice(w.abstract_inverted_index),
    palabras: (w.keywords ?? []).map((k) => k?.display_name).filter(Boolean),
    tipo: w.type ?? null,
  };
}

/** Un resultado de una base de `externas` en la forma común. */
function deExterna(r, base) {
  return {
    base,
    titulo: r.titulo ?? '',
    autores: autoresDeApa(r.autores),
    anio: r.anio ?? null,
    revista: r.revista ?? null,
    volumen: null,
    numero: null,
    paginaInicio: null,
    paginaFin: null,
    doi: openalex.limpiarDoi(r.doi),
    url: r.enlace ?? null,
    idioma: r.idioma ?? null,
    resumen: r.resumen ?? null,
    palabras: [],
    tipo: r.tipo ?? null,
  };
}

/** La identidad para no repetir en `_todo.ris`: el DOI, o el título y el año. */
function identidad(r) {
  if (r.doi) return `doi:${r.doi.toLowerCase()}`;
  const titulo = String(r.titulo)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `t:${titulo}|${r.anio ?? ''}`;
}

// ── Cada base ───────────────────────────────────────────────────────────────

/**
 * Scopus: los DOI de su búsqueda (`doisDeScopus`, que es
 * `scopus.service.doisParaCorpus` y se pasa de fuera para no cargar aquí las
 * sesiones de Elsevier) y lo demás de OpenAlex.
 */
async function deScopus({ ecuacion, cuantas, doisDeScopus }) {
  const { dois, total, recorridos } = await doisDeScopus({ ecuacion, tope: cuantas });
  const obras = dois.length > 0 ? await openalex.obrasCompletasPorDoi(dois) : [];
  return {
    obras,
    total,
    bajados: obras.length,
    consulta: ecuacion,
    notas: [
      recorridos - dois.length > 0 ? `${recorridos - dois.length} sin DOI` : null,
      dois.length - obras.length > 0 ? `${dois.length - obras.length} con DOI que OpenAlex no conoce` : null,
    ].filter(Boolean),
    recorridos,
  };
}

async function deOpenAlexBase({ consulta, cuantas, desdeAnio, hastaAnio, tipos, idiomas, soloScielo }) {
  const r = await openalex.obrasDeUnaBusqueda({
    consulta,
    cuantas,
    desdeAnio,
    hastaAnio,
    tipos,
    idiomas,
    soloScielo,
  });
  return { obras: r.obras, total: r.total, bajados: r.obras.length, consulta: r.filtro, caida: r.caida, notas: [] };
}

/** Una base de `externas`, página a página hasta `cuantas` o hasta el plazo. */
async function deUnaExterna({ base, consulta, cuantas, desdeAnio, hastaAnio, vence }) {
  const porPagina = 25;
  const resultados = [];
  let total = 0;
  let caida = false;
  let cortada = false;

  for (let pagina = 1; resultados.length < cuantas; pagina += 1) {
    if (Date.now() > vence) {
      cortada = true;
      break;
    }
    const r = await base.buscar({
      consulta,
      palabras: palabrasDe(consulta),
      pagina,
      porPagina,
      desde: desdeAnio ?? null,
      hasta: hastaAnio ?? null,
    });
    if (r.caida) {
      caida = pagina === 1;
      break;
    }
    total = r.total ?? total;
    resultados.push(...(r.resultados ?? []));
    if ((r.resultados ?? []).length < porPagina) break;
  }

  return {
    registros: resultados.slice(0, cuantas).map((x) => deExterna(x, base.nombre)),
    total,
    caida,
    cortada,
  };
}

// ── Todo junto ──────────────────────────────────────────────────────────────

/**
 * Corre la búsqueda en cada base y devuelve los archivos y lo que pasó en
 * cada una. No guarda nada: `guardar` lo hace quien llama.
 *
 * @returns {{ archivos: {nombre, bytes}[], bases: object[], fecha: string, clave: string, unicos: number }}
 */
async function armar({
  clave,
  bases,
  ecuacionScopus = null,
  consulta = null,
  desdeAnio = null,
  hastaAnio = null,
  soloArticulos = true,
  idiomas = null,
  maximoPorBase = POR_DEFECTO,
  doisDeScopus = null,
  ahora = new Date(),
}) {
  const k = claveSegura(clave);
  const cuantas = Math.min(Math.max(Math.trunc(maximoPorBase) || POR_DEFECTO, 25), TOPE_POR_BASE);
  const pedidas = [...new Set((bases ?? []).map(String))];
  if (pedidas.length === 0) throw new ValidationError('Di en qué bases buscar.');

  const desconocidas = pedidas.filter((b) => !PROPIAS[b] && !externas.base(b));
  if (desconocidas.length > 0) {
    throw new ValidationError(`No conozco estas bases: ${desconocidas.join(', ')}.`);
  }
  if (pedidas.includes('scopus') && !String(ecuacionScopus ?? '').trim()) {
    throw new ValidationError('Para Scopus hace falta la ecuación con su sintaxis (TITLE-ABS-KEY…).');
  }
  if (pedidas.some((b) => b !== 'scopus') && !String(consulta ?? '').trim()) {
    throw new ValidationError('Para las bases que no son Scopus hace falta la consulta (en "consulta").');
  }

  const vence = Date.now() + PLAZO_MS;
  const tipos = soloArticulos ? TIPOS_ARTICULO : null;
  // La fecha del tesista, no la del servidor: de noche en Lima ya es mañana en UTC.
  const fecha = ahora.toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });

  const archivos = [];
  const informe = [];
  const todos = [];
  const obrasParaEtiquetas = [];
  const csvPendientes = [];

  for (const clv of pedidas) {
    const nombre = nombreDe(clv);
    const fila = { clave: clv, nombre, total: 0, bajados: 0, archivo: null, consulta: null, notas: [], caida: false };
    informe.push(fila);

    if (Date.now() > vence) {
      fila.notas.push('no se buscó: se acabó el tiempo de esta llamada; pídela otra vez solo con esta base');
      continue;
    }

    try {
      if (clv === 'scopus' || clv === 'openalex' || clv === 'scielo') {
        const r =
          clv === 'scopus'
            ? await deScopus({ ecuacion: ecuacionScopus, cuantas, doisDeScopus })
            : await deOpenAlexBase({
                consulta,
                cuantas,
                desdeAnio,
                hastaAnio,
                tipos,
                idiomas,
                soloScielo: clv === 'scielo',
              });
        Object.assign(fila, {
          total: r.total,
          bajados: r.bajados,
          consulta: r.consulta,
          caida: Boolean(r.caida),
          notas: r.notas,
        });
        if (clv !== 'scopus' && /[*?]/.test(consulta)) {
          fila.notas.push('sin el truncamiento * (OpenAlex busca por raíz y no lo admite)');
        }
        if (r.obras.length > 0) {
          fila.archivo = `busqueda_${k}_${clv}.csv`;
          csvPendientes.push({ nombre: fila.archivo, obras: r.obras });
          obrasParaEtiquetas.push(...r.obras);
          todos.push(...r.obras.map((w) => deOpenAlex(w, nombre)));
        }
      } else if (!externas.base(clv).activa()) {
        fila.caida = true;
        fila.notas.push('esta base está apagada en el servidor (le falta su clave)');
      } else {
        const r = await deUnaExterna({ base: externas.base(clv), consulta, cuantas, desdeAnio, hastaAnio, vence });
        Object.assign(fila, {
          total: r.total,
          bajados: r.registros.length,
          consulta: `${consulta}${desdeAnio || hastaAnio ? ` · años ${desdeAnio ?? '…'}-${hastaAnio ?? '…'}` : ''}`,
          caida: r.caida,
        });
        if (r.cortada) fila.notas.push('cortada por tiempo: hay más páginas');
        if (r.registros.length > 0) {
          fila.archivo = `busqueda_${k}_${clv}.ris`;
          archivos.push({ nombre: fila.archivo, bytes: Buffer.from(ris(r.registros), 'utf8') });
          todos.push(...r.registros);
        }
      }
    } catch (error) {
      // Una base que falla no tumba las otras. El mensaje de Scopus ya viene
      // escrito para el tesista; el de las demás, no.
      logger.warn({ err: error, base: clv }, 'Corpus de revisión: una base falló');
      fila.caida = true;
      fila.notas.push(error?.isOperational ? error.message : 'la base no respondió');
    }
  }

  // Las referencias más citadas con «Autor (año)», una vez para todos los CSV.
  const etiquetas = obrasParaEtiquetas.length > 0 ? await mapeo.etiquetasDeReferencias(obrasParaEtiquetas) : new Map();
  for (const { nombre, obras } of csvPendientes) {
    archivos.push({ nombre, bytes: Buffer.from(mapeo.csvDeOpenAlex(obras, etiquetas), 'utf8') });
  }

  // Todo junto para Zotero o Mendeley, sin repetir.
  const vistos = new Set();
  const unicos = todos.filter((r) => {
    const id = identidad(r);
    if (vistos.has(id)) return false;
    vistos.add(id);
    return true;
  });
  if (unicos.length > 0) {
    archivos.push({ nombre: `busqueda_${k}_todo.ris`, bytes: Buffer.from(ris(unicos), 'utf8') });
  }

  const registro = registroDeLaBusqueda({ fecha, informe, cuantas, soloArticulos, idiomas, unicos: unicos.length });
  archivos.push({ nombre: `busqueda_${k}_registro.txt`, bytes: Buffer.from(registro, 'utf8') });

  return { archivos, bases: informe, fecha, clave: k, unicos: unicos.length, cuantas };
}

/** La hoja «Búsqueda» del PRISMA, en texto: lo que otro necesita para repetirla. */
function registroDeLaBusqueda({ fecha, informe, cuantas, soloArticulos, idiomas, unicos }) {
  const lineas = [
    'Registro de la búsqueda — armada con el conector de Acosta | IA & Research',
    `Fecha: ${fecha}`,
    `Tope por base: ${cuantas} registros (los más citados primero).`,
    `Tipo de documento (OpenAlex y SciELO): ${soloArticulos ? 'artículos y revisiones' : 'todos'}.`,
    idiomas?.length ? `Idiomas (OpenAlex y SciELO): ${idiomas.join(', ')}.` : null,
    '',
  ].filter((l) => l !== null);

  for (const b of informe) {
    lineas.push(`== ${b.nombre} ==`);
    lineas.push(`Consulta literal: ${b.consulta ?? '(no se corrió)'}`);
    lineas.push(`Resultados en la base: ${b.total} · Bajados: ${b.bajados}`);
    if (b.archivo) lineas.push(`Archivo: ${b.archivo}`);
    if (b.notas.length) lineas.push(`Notas: ${b.notas.join('; ')}`);
    lineas.push('');
  }

  lineas.push(
    `Registros distintos entre todas las bases (por DOI o título y año): ${unicos}. Es solo una ` +
      'referencia: los duplicados del PRISMA los cuenta corpus.py identificar.',
    'En Scopus, la lista de documentos es la de Scopus y sus datos (autores, resumen, palabras ' +
      'clave, referencias) vienen de OpenAlex por el DOI. SciELO se consulta por OpenAlex (revistas ' +
      'listadas en SciELO). Decláralo así en los Métodos.',
  );
  return `${lineas.join('\n')}\n`;
}

module.exports = {
  armar,
  claveSegura,
  palabrasDe,
  autoresDeApa,
  ris,
  deOpenAlex,
  deExterna,
  registroDeLaBusqueda,
  PROPIAS,
  POR_DEFECTO,
  TOPE_POR_BASE,
};
