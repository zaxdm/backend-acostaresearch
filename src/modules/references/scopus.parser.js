'use strict';

const { normalizar } = require('./zotero.mapper');

/**
 * Lee un export bibliográfico y lo convierte en fichas.
 *
 * Entiende los tres formatos que ofrecen Scopus, Web of Science y SciELO: CSV,
 * RIS y BibTeX. El comprador descarga lo que su base le dé y lo sube; adivinar
 * el formato aquí cuesta veinte líneas y le ahorra tener que saber cuál eligió.
 *
 * Y los de texto plano, que se descargan como `.txt`: el «Plain text» de Scopus,
 * el «Plain text file» y el «Tab-delimited» de Web of Science, y el MEDLINE de
 * PubMed. Son lo que sale al pulsar la opción que parece más sencilla, y hasta
 * ahora acababan en «no encontramos ninguna fuente» sin más explicación.
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
  // Scopus escribe «Page start»/«Page end»; Web of Science, «Beginning
  // Page»/«Ending Page» o «BP»/«EP». Alguno trae ya el rango en «Pages».
  volume: ['volume', 'vl'],
  issue: ['issue', 'is'],
  pageStart: ['page start', 'beginning page', 'start page', 'bp', 'sp'],
  pageEnd: ['page end', 'ending page', 'ep'],
  pages: ['pages', 'page range'],
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
  return filasAFichas(leerCsv(texto));
}

/** De una tabla ya partida —cabecera y filas— a fichas. Vale para CSV y tabulado. */
function filasAFichas(filas) {
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
    volume: de(fila, indices.volume),
    issue: de(fila, indices.issue),
    pages: de(fila, indices.pages),
    pageStart: de(fila, indices.pageStart),
    pageEnd: de(fila, indices.pageEnd),
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
  VL: 'volume',
  IS: 'issue',
  SP: 'pageStart',
  EP: 'pageEnd',
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
      actual = { title: '', authors: '', year: '', source: '', doi: '', url: '', abstract: '', keywords: '', eid: '', itemType: valor.trim(), volume: '', issue: '', pages: '', pageStart: '', pageEnd: '' };
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
      volume: campos.volume ?? '',
      // En BibTeX el número de la revista se llama «number», no «issue».
      issue: campos.number ?? campos.issue ?? '',
      pages: campos.pages ?? '',
    });
  }

  return fichas;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabulado (el «Tab-delimited» de Web of Science)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parte por tabuladores, SIN tratar las comillas.
 *
 * Web of Science no entrecomilla nada en este formato: un título con una cita
 * dentro lleva sus comillas tal cual. Pasarlo por el lector de CSV abriría un
 * campo entrecomillado ahí y se tragaría el resto del archivo.
 */
function desdeTabulado(texto) {
  const filas = texto
    .split(/\r?\n/)
    .filter((linea) => linea.trim() !== '')
    .map((linea) => linea.split('\t'));

  return filasAFichas(filas);
}

// ─────────────────────────────────────────────────────────────────────────────
// Etiquetado (el «Plain text file» de Web of Science y el MEDLINE de PubMed)
// ─────────────────────────────────────────────────────────────────────────────

const fichaVacia = () => ({
  title: '',
  authors: '',
  year: '',
  source: '',
  doi: '',
  url: '',
  abstract: '',
  keywords: '',
  eid: '',
  itemType: '',
  volume: '',
  issue: '',
  pages: '',
  pageStart: '',
  pageEnd: '',
});

/**
 * Lee un formato de etiquetas con líneas de continuación.
 *
 * Los dos se parecen: una etiqueta al principio de la línea y, si el valor no
 * cabe, líneas siguientes con sangría. Cambian la forma de la etiqueta, con qué
 * etiqueta empieza cada ficha y qué significa la continuación: en WoS, la
 * continuación de `AU` es OTRO autor; la de un resumen es el mismo párrafo.
 */
function desdeEtiquetas(texto, { linea, empieza, termina, porLinea, poner }) {
  const fichas = [];
  let actual = null;
  let ultima = null;

  for (const cruda of texto.split(/\r?\n/)) {
    const encontrada = linea.exec(cruda);

    if (!encontrada) {
      const resto = cruda.trim();
      if (actual && ultima && resto) {
        poner(actual, ultima, resto, !porLinea.has(ultima));
      }
      continue;
    }

    const [, etiqueta, valor] = encontrada;

    if (etiqueta === empieza) {
      actual = fichaVacia();
      fichas.push(actual);
    }
    if (etiqueta === termina) {
      actual = null;
      ultima = null;
      continue;
    }
    if (!actual) continue;

    poner(actual, etiqueta, (valor ?? '').trim(), false);
    ultima = etiqueta;
  }

  return fichas;
}

/**
 * Añade un valor a un campo de la ficha.
 *
 * `sigue` es una línea de continuación del MISMO valor: se pega con un espacio.
 * Si no, en autores y palabras clave es uno más de la lista, y en el resto gana
 * el primero —una segunda etiqueta de título es otra variante, no una suma—.
 */
function anadir(ficha, campo, valor, sigue) {
  if (!valor) return;

  if (sigue) {
    ficha[campo] = ficha[campo] ? `${ficha[campo]} ${valor}` : valor;
  } else if (campo === 'authors' || campo === 'keywords') {
    ficha[campo] = ficha[campo] ? `${ficha[campo]}; ${valor}` : valor;
  } else if (!ficha[campo]) {
    ficha[campo] = valor;
  }
}

/** Las etiquetas de Web of Science que interesan. */
const WOS = {
  TI: 'title',
  AU: 'authors',
  PY: 'year',
  SO: 'source',
  DI: 'doi',
  AB: 'abstract',
  DE: 'keywords',
  ID: 'keywords',
  UT: 'eid',
  DT: 'itemType',
  VL: 'volume',
  IS: 'issue',
  BP: 'pageStart',
  EP: 'pageEnd',
};

function desdeWos(texto) {
  return desdeEtiquetas(texto, {
    // «AU Hernandez, R» — dos caracteres, un espacio, el valor. «ER» va solo.
    linea: /^([A-Z][A-Z0-9])(?: (.*))?$/,
    empieza: 'PT',
    termina: 'ER',
    // Cada línea de continuación de estas es un autor más.
    porLinea: new Set(['AU']),
    poner(ficha, etiqueta, valor, sigue) {
      const campo = WOS[etiqueta];
      if (!campo) return;
      // La continuación de AU llega con `sigue` a false: es otro autor.
      anadir(ficha, campo, valor ?? '', sigue);
    },
  });
}

/** Las etiquetas de MEDLINE que interesan. El DOI y los autores, aparte. */
const MEDLINE = {
  TI: 'title',
  DP: 'year',
  JT: 'source',
  AB: 'abstract',
  OT: 'keywords',
  PT: 'itemType',
  // PubMed nombra distinto: volumen es VI, número es IP y el rango, PG.
  VI: 'volume',
  IP: 'issue',
  PG: 'pages',
};

function desdeMedline(texto) {
  const fichas = desdeEtiquetas(texto, {
    // «TI  - Un título», «PMID- 12345678». Hasta cuatro letras, rellenas.
    linea: /^([A-Z]{2,4})\s*- (.*)$/,
    empieza: 'PMID',
    termina: null,
    porLinea: new Set(),
    poner(ficha, etiqueta, valor, sigue) {
      if (etiqueta === 'PMID') {
        ficha.eid = `pmid:${valor}`;
      } else if (etiqueta === 'FAU') {
        // «Smith, John». Mejor que «Smith J», que es lo que trae AU.
        anadir(ficha, 'authors', valor, sigue);
      } else if (etiqueta === 'AU') {
        anadir(ficha, 'autoresCortos', valor, sigue);
      } else if (etiqueta === 'TA') {
        anadir(ficha, 'revistaCorta', valor, sigue);
      } else if ((etiqueta === 'LID' || etiqueta === 'AID') && /\[doi\]\s*$/.test(valor)) {
        // «10.1016/j.x.2023.01.002 [doi]». Las otras variantes son el PII.
        anadir(ficha, 'doi', valor.replace(/\s*\[doi\]\s*$/, ''), false);
      } else if (MEDLINE[etiqueta]) {
        anadir(ficha, MEDLINE[etiqueta], valor, sigue);
      }
    },
  });

  return fichas.map(({ autoresCortos, revistaCorta, ...ficha }) => ({
    ...ficha,
    authors: ficha.authors || autoresCortos || '',
    source: ficha.source || revistaCorta || '',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// El «Plain text» de Scopus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las etiquetas que Scopus pone ANTES del título.
 *
 * Solo esas se reconocen como etiqueta en la cabeza de la ficha. Un título en
 * mayúsculas con dos puntos —«TEACHING: A REVIEW»— tiene la misma forma que una
 * etiqueta, y tomarlo por una se comería el título.
 */
const ETIQUETAS_DE_CABEZA = new Set(['AUTHOR FULL NAMES', 'AUTHOR(S) ID', 'AUTHORS']);

/** Una línea «ETIQUETA: valor» de Scopus. */
const ETIQUETA_SCOPUS = /^([A-Z][A-Z0-9 ()/&.-]*[A-Z)]):\s?(.*)$/;

/**
 * Lee el «Plain text» de Scopus.
 *
 * Es el único de los formatos sin una etiqueta en cada campo. La ficha empieza
 * con líneas sueltas —autores, título, «(2023) Revista, 12 (3), pp. 1-10.», el
 * enlace— y sigue con etiquetas —DOI:, ABSTRACT:, AUTHOR KEYWORDS:—. Acaba en
 * «SOURCE: Scopus». Las líneas sueltas se reconocen por su forma: el año entre
 * paréntesis, el enlace por su http, y de las demás la primera son los autores
 * y la segunda el título.
 */
function desdeScopusTxt(texto) {
  const fichas = [];
  let sueltas = [];
  let actual = fichaVacia();
  let hayAlgo = false;

  const cerrar = () => {
    if (hayAlgo) {
      // Sin autores, Scopus no deja la línea vacía: escribe este aviso.
      const autores = sueltas[0] ?? '';
      actual.authors = /^\[No author name available\]$/i.test(autores) ? '' : autores;
      actual.title = sueltas[1] ?? '';
      fichas.push(actual);
    }
    actual = fichaVacia();
    sueltas = [];
    hayAlgo = false;
  };

  // La cabecera del archivo: «Scopus» y «EXPORT DATE: …». No es una ficha.
  const lineas = texto.split(/\r?\n/);
  let i = 0;
  while (i < lineas.length && (/^\s*(Scopus)?\s*$/.test(lineas[i]) || /^EXPORT DATE:/.test(lineas[i]))) {
    i += 1;
  }

  for (; i < lineas.length; i += 1) {
    const linea = lineas[i].trim();
    if (!linea) continue;

    const etiqueta = ETIQUETA_SCOPUS.exec(linea);
    const esEtiqueta =
      etiqueta && (sueltas.length >= 2 || ETIQUETAS_DE_CABEZA.has(etiqueta[1]));

    if (esEtiqueta) {
      const [, nombre, valor] = etiqueta;
      hayAlgo = true;

      if (nombre === 'SOURCE') {
        cerrar();
      } else if (nombre === 'DOI') {
        anadir(actual, 'doi', valor, false);
      } else if (nombre === 'ABSTRACT') {
        anadir(actual, 'abstract', valor, false);
      } else if (nombre === 'AUTHOR KEYWORDS' || nombre === 'INDEX KEYWORDS') {
        anadir(actual, 'keywords', valor, false);
      } else if (nombre === 'DOCUMENT TYPE') {
        anadir(actual, 'itemType', valor, false);
      }
      continue;
    }

    hayAlgo = true;
    const conAnio = /^\((\d{4})\)\s*(.*)$/.exec(linea);

    if (conAnio) {
      actual.year = conAnio[1];
      // «Revista de Educación, 45 (2), pp. 123-145. Cited 3 times.» → la revista.
      // El nombre puede llevar comas; lo que viene detrás empieza por número.
      const cola = conAnio[2];
      actual.source = cola
        .split(/,\s*(?=\d|pp\.|art\.|Cited)/)[0]
        .replace(/\.\s*$/, '')
        .trim();

      // «Revista de Educación, 45 (2), pp. 123-145. Cited 3 times.»
      //
      // El volumen es el primer número que sigue al nombre de la revista, y el
      // número va entre paréntesis detrás. Se busca DESPUÉS de la coma para no
      // llevarse un año o una cifra del propio título de la revista.
      const volumen = /,\s*(\d+[A-Za-z]?)\s*(?:\(([^)]+)\))?/.exec(cola);
      if (volumen) {
        actual.volume = volumen[1];
        if (volumen[2]) actual.issue = volumen[2].trim();
      }

      // Las páginas van tras «pp.». Cuando el artículo no las tiene —los
      // electrónicos no—, Scopus pone su número de artículo, que es lo que
      // ocupa su sitio en la referencia.
      const paginas = /\bpp?\.\s*([\dA-Za-z]+(?:\s*[-–]{1,2}\s*[\dA-Za-z]+)?)/.exec(cola);
      const articulo = /\bart\.\s*(?:no\.)?\s*([^\s,]+)/i.exec(cola);
      if (paginas) actual.pages = paginas[1].replace(/\s*[-–]+\s*/, '-');
      else if (articulo) actual.pages = articulo[1].replace(/[.,]$/, '');
    } else if (/^https?:\/\//i.test(linea)) {
      actual.url = linea;
      const eid = /[?&]eid=([^&]+)/.exec(linea);
      if (eid) actual.eid = decodeURIComponent(eid[1]);
    } else {
      sueltas.push(linea);
    }
  }

  cerrar();
  return fichas;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adivina el formato por su contenido, no por la extensión.
 *
 * La extensión miente a menudo: Scopus descarga el RIS como `.ris` pero muchos
 * gestores lo guardan como `.txt`, y un CSV renombrado a `.xls` es lo más común
 * que se sube. Se reconocen por su primera línea útil.
 *
 * El orden importa. MEDLINE va antes que RIS porque sus etiquetas tienen la
 * misma forma («TI  - »), y el tabulado antes que el CSV porque un título con
 * comas en una línea con tabuladores no es un CSV.
 */
function formatoDe(texto) {
  const cabeza = texto.slice(0, 2000);
  const primera = cabeza.split(/\r?\n/, 1)[0];

  if (/^\s*@\w+\s*\{/m.test(cabeza)) return 'bibtex';
  if (/^PMID- /m.test(cabeza)) return 'pubmed';
  if (/^TY\s{2}-/m.test(cabeza)) return 'ris';
  if (/^(FN |VR |PT [A-Z])/m.test(cabeza) && /^ER\s*$/m.test(texto)) return 'wos txt';
  if (/^SOURCE:\s*Scopus\s*$/m.test(texto) || /^EXPORT DATE:/m.test(cabeza)) return 'scopus txt';
  if ((primera.match(/\t/g) ?? []).length > (primera.match(/,/g) ?? []).length) {
    return 'wos tsv';
  }
  return 'csv';
}

/** Cada formato, con su lector. */
const LECTORES = {
  bibtex: desdeBibtex,
  pubmed: desdeMedline,
  ris: desdeRis,
  'wos txt': desdeWos,
  'scopus txt': desdeScopusTxt,
  'wos tsv': desdeTabulado,
  csv: desdeCsv,
};

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
/**
 * El rango de páginas, venga como venga.
 *
 * Unos formatos lo dan entero («45-62») y otros en dos campos. Se normaliza el
 * guion: los exports traen guion corto, guion largo y a veces dos guiones, y
 * tres formas de escribir lo mismo en una bibliografía se ven como un descuido.
 */
function rangoDePaginas(ficha) {
  const entero = String(ficha.pages ?? '').trim();
  if (entero) return entero.replace(/\s*[-–—]+\s*/, '-');

  const desde = String(ficha.pageStart ?? '').trim();
  const hasta = String(ficha.pageEnd ?? '').trim();
  if (desde && hasta) return `${desde}-${hasta}`;
  return desde || null;
}

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
    volume: recortar(ficha.volume, 40),
    issue: recortar(ficha.issue, 40),
    pages: recortar(rangoDePaginas(ficha), 40),
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
 * El texto del archivo, en la codificación en que venga.
 *
 * El «Tab-delimited (Win)» de Web of Science sale en UTF-16, y leído como UTF-8
 * es un carácter nulo entre cada letra: ninguna cabecera coincide y el archivo
 * parece vacío. Lo delata su marca de orden de bytes.
 */
function decodificar(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').slice(1);
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/**
 * Lee el archivo entero y devuelve las filas listas para guardar.
 *
 * Las repetidas DENTRO del propio archivo se quitan aquí: exportar dos búsquedas
 * de Scopus que se solapan es lo normal, y sin esto la inserción por lotes
 * chocaría contra su propio índice único a mitad de camino.
 */
function leer(buffer) {
  const texto = decodificar(buffer);
  const formato = formatoDe(texto);
  const fichas = LECTORES[formato](texto);

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
