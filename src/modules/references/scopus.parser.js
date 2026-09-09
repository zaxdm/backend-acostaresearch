'use strict';

const { normalizar } = require('./zotero.mapper');

/**
 * Lee un export bibliográfico y lo convierte en fichas.
 *
 * Entiende los tres formatos que ofrecen Scopus, Web of Science y SciELO: CSV,
 * RIS y BibTeX. El comprador descarga lo que su base le dé y lo sube; adivinar
 * el formato aquí cuesta veinte líneas y le ahorra tener que saber cuál eligió.
 *
 * POR QUÉ EL CSV NO SE PARTE POR COMAS
 * ------------------------------------
 * Es la trampa que hunde estos importadores, y no avisa: falla en silencio y
 * guarda basura. Los resúmenes de Scopus llevan comas, comillas y SALTOS DE
 * LÍNEA dentro del campo, entrecomillados según el RFC 4180. Partir por comas
 * corta un resumen por la mitad, desplaza todas las columnas de esa fila y
 * guarda el año en el DOI sin quejarse de nada. Por eso hay un lector de
 * verdad, con su máquina de estados, y no un `split`.
 *
 * No se usa una librería porque son ciento veinte líneas para un formato que no
 * cambia desde 2005, y una dependencia más en la cadena de suministro de algo
 * que recibe archivos de fuera cuesta más que mantener esto.
 */

/** Techo por archivo. Una tesis real no pasa de unos cientos de fuentes. */
const MAXIMO_FILAS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parte un CSV respetando comillas y saltos de línea dentro de los campos.
 *
 * Dos comillas seguidas dentro de un campo entrecomillado son una comilla
 * literal; es como el RFC escapa las comillas y como las escribe Scopus cuando
 * el título de un artículo lleva una cita dentro.
 */
function leerCsv(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];

    if (entreComillas) {
      if (c !== '"') {
        campo += c;
      } else if (texto[i + 1] === '"') {
        campo += '"';
        i += 1;
      } else {
        entreComillas = false;
      }
      continue;
    }

    if (c === '"') {
      entreComillas = true;
    } else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      // \r\n cuenta como un solo final de línea.
      if (c === '\r' && texto[i + 1] === '\n') i += 1;
      fila.push(campo);
      campo = '';
      // Una línea vacía al final del archivo no es una fila.
      if (fila.length > 1 || fila[0] !== '') filas.push(fila);
      fila = [];
    } else {
      campo += c;
    }
  }

  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  return filas;
}

/**
 * A qué columna corresponde cada cabecera.
 *
 * Se buscan por nombre y no por posición porque el orden depende de lo que el
 * usuario marcara al exportar, y porque cada base la titula a su manera:
 * «Source title» en Scopus, «Journal» en algunas exportaciones de WoS.
 */
const COLUMNAS_CSV = {
  title: ['title', 'document title', 'ti'],
  authors: ['authors', 'author full names', 'author names', 'au'],
  year: ['year', 'publication year', 'py'],
  source: ['source title', 'journal', 'publication name', 'so'],
  doi: ['doi', 'di'],
  url: ['link', 'url', 'doi link'],
  abstract: ['abstract', 'ab'],
  keywords: ['author keywords', 'index keywords', 'keywords', 'de', 'id'],
  eid: ['eid', 'ut', 'accession number'],
  itemType: ['document type', 'dt'],
};

function indicesDeCabecera(cabecera) {
  const limpias = cabecera.map((c) => normalizar(c).replace(/^﻿/, '').trim());
  const indices = {};

  for (const [campo, nombres] of Object.entries(COLUMNAS_CSV)) {
    // Las palabras clave llegan repartidas en dos columnas y se juntan las dos.
    const encontrados = [];
    for (const nombre of nombres) {
      const donde = limpias.indexOf(nombre);
      if (donde !== -1) encontrados.push(donde);
    }
    if (encontrados.length > 0) {
      indices[campo] = campo === 'keywords' ? encontrados : encontrados[0];
    }
  }

  return indices;
}

function desdeCsv(texto) {
  const filas = leerCsv(texto);
  if (filas.length < 2) return [];

  const indices = indicesDeCabecera(filas[0]);
  if (indices.title === undefined) return [];

  const de = (fila, indice) => (indice === undefined ? '' : (fila[indice] ?? '').trim());

  return filas.slice(1).map((fila) => ({
    title: de(fila, indices.title),
    authors: de(fila, indices.authors),
    year: de(fila, indices.year),
    source: de(fila, indices.source),
    doi: de(fila, indices.doi),
    url: de(fila, indices.url),
    abstract: de(fila, indices.abstract),
    keywords: (indices.keywords ?? [])
      .map((i) => de(fila, i))
      .filter(Boolean)
      .join('; '),
    eid: de(fila, indices.eid),
    itemType: de(fila, indices.itemType),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// RIS
// ─────────────────────────────────────────────────────────────────────────────

/** Etiquetas de RIS que interesan. El resto del formato se ignora sin ruido. */
const RIS = {
  TI: 'title',
  T1: 'title',
  AU: 'authors',
  A1: 'authors',
  PY: 'year',
  Y1: 'year',
  JO: 'source',
  JF: 'source',
  T2: 'source',
  DO: 'doi',
  UR: 'url',
  AB: 'abstract',
  N2: 'abstract',
  KW: 'keywords',
  TY: 'itemType',
};

function desdeRis(texto) {
  const fichas = [];
  let actual = null;
  let ultimoCampo = null;

  for (const linea of texto.split(/\r?\n/)) {
    const etiqueta = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(linea);

    if (!etiqueta) {
      // Continuación del campo anterior: los resúmenes largos vienen partidos.
      if (actual && ultimoCampo && linea.trim()) {
        actual[ultimoCampo] = `${actual[ultimoCampo]} ${linea.trim()}`.trim();
      }
      continue;
    }

    const [, clave, valor] = etiqueta;

    if (clave === 'TY') {
      actual = { title: '', authors: '', year: '', source: '', doi: '', url: '', abstract: '', keywords: '', eid: '', itemType: valor.trim() };
      fichas.push(actual);
      ultimoCampo = null;
      continue;
    }

    if (clave === 'ER') {
      actual = null;
      ultimoCampo = null;
      continue;
    }

    if (!actual) continue;

    const campo = RIS[clave];
    if (!campo || campo === 'itemType') continue;

    // Autores y palabras clave vienen en una etiqueta por valor.
    if (campo === 'authors' || campo === 'keywords') {
      actual[campo] = actual[campo] ? `${actual[campo]}; ${valor.trim()}` : valor.trim();
    } else if (!actual[campo]) {
      actual[campo] = valor.trim();
    }

    ultimoCampo = campo;
  }

  return fichas;
}

// ─────────────────────────────────────────────────────────────────────────────
// BibTeX
// ─────────────────────────────────────────────────────────────────────────────

/** Lee los campos de una entrada, contando llaves para no cortar donde no es. */
function camposDeBibtex(cuerpo) {
  const campos = {};
  const expresion = /(\w+)\s*=\s*/g;
  let coincidencia;

  while ((coincidencia = expresion.exec(cuerpo)) !== null) {
    const clave = coincidencia[1].toLowerCase();
    let i = expresion.lastIndex;
    let valor = '';

    if (cuerpo[i] === '{') {
      // Se cuentan las llaves para saber dónde acaba el campo, pero ninguna se
      // copia: en BibTeX las interiores solo marcan grupos —protegen mayúsculas
      // en títulos, sobre todo— y no forman parte del texto.
      let nivel = 0;
      for (; i < cuerpo.length; i += 1) {
        if (cuerpo[i] === '{') {
          nivel += 1;
          continue;
        }
        if (cuerpo[i] === '}') {
          nivel -= 1;
          if (nivel === 0) break;
          continue;
        }
        valor += cuerpo[i];
      }
      i += 1;
    } else if (cuerpo[i] === '"') {
      i += 1;
      for (; i < cuerpo.length && cuerpo[i] !== '"'; i += 1) valor += cuerpo[i];
      i += 1;
    } else {
      for (; i < cuerpo.length && cuerpo[i] !== ',' && cuerpo[i] !== '\n'; i += 1) valor += cuerpo[i];
    }

    campos[clave] = valor.replace(/\s+/g, ' ').trim();
    expresion.lastIndex = i;
  }

  return campos;
}

function desdeBibtex(texto) {
  const fichas = [];
  const expresion = /@(\w+)\s*\{/g;
  let coincidencia;

  while ((coincidencia = expresion.exec(texto)) !== null) {
    // Se recorta hasta la siguiente entrada y se deja que el lector de campos
    // haga el trabajo fino con las llaves.
    const desde = expresion.lastIndex;
    const siguiente = texto.indexOf('\n@', desde);
    const cuerpo = texto.slice(desde, siguiente === -1 ? texto.length : siguiente);
    const campos = camposDeBibtex(cuerpo);

    fichas.push({
      title: campos.title ?? '',
      // BibTeX separa autores con «and»; el resto del código espera «;».
      authors: (campos.author ?? '').split(/\s+and\s+/).filter(Boolean).join('; '),
      year: campos.year ?? '',
      source: campos.journal ?? campos.booktitle ?? campos.publisher ?? '',
      doi: campos.doi ?? '',
      url: campos.url ?? '',
      abstract: campos.abstract ?? '',
      keywords: campos.keywords ?? '',
      eid: '',
      itemType: coincidencia[1],
    });
  }

  return fichas;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adivina el formato por su contenido, no por la extensión.
 *
 * La extensión miente a menudo: Scopus descarga el RIS como `.ris` pero muchos
 * gestores lo guardan como `.txt`, y un CSV renombrado a `.xls` es lo más común
 * que se sube. Los tres formatos se reconocen por su primera línea útil.
 */
function formatoDe(texto) {
  const cabeza = texto.slice(0, 2000);
  if (/^\s*@\w+\s*\{/m.test(cabeza)) return 'bibtex';
  if (/^TY\s{2}-/m.test(cabeza)) return 'ris';
  return 'csv';
}

/** «Hernández R., Fernández C.» → «Hernández, R.; Fernández, C.» */
function autoresEnFormatoDeCita(crudo) {
  if (!crudo) return '';
  if (crudo.includes(';')) return crudo.replace(/\s*;\s*/g, '; ').trim();

  return crudo
    .split(',')
    .map((parte) => parte.trim())
    .filter(Boolean)
    .map((persona) => {
      const partes = persona.split(/\s+/);
      if (partes.length < 2) return persona;
      const iniciales = partes.pop();
      return `${partes.join(' ')}, ${iniciales}`;
    })
    .join('; ');
}

const recortar = (valor, largo) => {
  const texto = String(valor ?? '').trim();
  return texto ? texto.slice(0, largo) : null;
};

/** Un DOI limpio, venga como identificador o como enlace. */
function limpiarDoi(crudo) {
  const valor = String(crudo ?? '').trim();
  if (!valor) return null;
  return valor.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').slice(0, 200) || null;
}

function anio(crudo) {
  const encontrado = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(String(crudo ?? ''));
  return encontrado ? Number(encontrado[1]) : null;
}

/**
 * Convierte una ficha cruda en la fila que espera la tabla.
 *
 * Devuelve null cuando no hay título: una fuente sin título no se puede citar
 * ni encontrar, así que no vale la pena guardarla. Es también lo que descarta
 * las filas de cabecera repetidas y las líneas de relleno del export.
 */
function aFila(ficha) {
  const titulo = recortar(ficha.title, 500);
  if (!titulo) return null;

  const doi = limpiarDoi(ficha.doi);
  const resumen = String(ficha.abstract ?? '').trim() || null;
  const etiquetas = recortar(String(ficha.keywords ?? '').replace(/\s*;\s*/g, ', '), 500) ?? '';
  const autores = recortar(autoresEnFormatoDeCita(ficha.authors), 500) ?? '';

  /**
   * La identidad. En este orden y no en otro: el DOI es universal y estable, el
   * EID solo vale dentro de Scopus, y el título es el último recurso —dos
   * ediciones del mismo trabajo lo comparten, pero es preferible perder una
   * duplicada a guardar la misma fuente cuatro veces.
   */
  const sourceRef =
    (doi && `doi:${doi.toLowerCase()}`) ||
    (ficha.eid && `eid:${String(ficha.eid).trim()}`) ||
    `titulo:${normalizar(titulo).replace(/[^a-z0-9]/g, '').slice(0, 180)}`;

  const fila = {
    zoteroKey: null,
    version: 0,
    origin: 'SCOPUS',
    sourceRef: sourceRef.slice(0, 200),
    itemType: recortar(ficha.itemType, 40) ?? 'journalArticle',
    title: titulo,
    authors: autores,
    year: anio(ficha.year),
    source: recortar(ficha.source, 300),
    doi,
    url: recortar(ficha.url, 500),
    abstract: resumen,
    // Sin nota: la nota es de Acosta y esto no lo escribió Acosta. Ver el
    // conector, que se apoya en esa diferencia para presentarlas distinto.
    notes: null,
    tags: etiquetas,
  };

  fila.busqueda = normalizar(
    [fila.title, fila.authors, fila.source, fila.year, resumen, etiquetas]
      .filter(Boolean)
      .join(' '),
  );

  return fila;
}

/**
 * Lee el archivo entero y devuelve las filas listas para guardar.
 *
 * Las repetidas DENTRO del propio archivo se quitan aquí: exportar dos búsquedas
 * de Scopus que se solapan es lo normal, y sin esto la inserción por lotes
 * chocaría contra su propio índice único a mitad de camino.
 */
function leer(buffer) {
  const texto = buffer.toString('utf8').replace(/^﻿/, '');
  const formato = formatoDe(texto);

  const fichas =
    formato === 'bibtex' ? desdeBibtex(texto) : formato === 'ris' ? desdeRis(texto) : desdeCsv(texto);

  const vistas = new Set();
  const filas = [];
  let descartadas = 0;

  for (const ficha of fichas) {
    if (filas.length >= MAXIMO_FILAS) break;

    const fila = aFila(ficha);
    if (!fila) {
      descartadas += 1;
      continue;
    }

    if (vistas.has(fila.sourceRef)) continue;
    vistas.add(fila.sourceRef);
    filas.push(fila);
  }

  return { formato, filas, leidas: fichas.length, descartadas };
}

module.exports = { leer, MAXIMO_FILAS, leerCsv };
