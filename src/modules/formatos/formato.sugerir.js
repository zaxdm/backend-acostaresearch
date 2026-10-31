'use strict';

const { abrirZip } = require('../projects/project.zip');
const busqueda = require('./formato.busqueda');

/**
 * La ficha que se adivina de un formato: universidad, siglas, facultad y grado
 * (31-oct).
 *
 * Las plantillas que suben los tesistas llegan a «por aprobar» con la ficha
 * vacía si su proyecto no tenía la universidad guardada. Pero casi todas traen
 * la portada: «UNIVERSIDAD NACIONAL MAYOR DE SAN MARCOS», «FACULTAD DE…», y el
 * nombre del archivo suele llevar la sigla («FORMATO DE PROYECTO UNMSM.docx»).
 * De ahí se propone la ficha; el administrador la revisa antes de aprobar.
 *
 * Si la universidad ya está en la biblioteca, se usan su nombre y sus otros
 * nombres tal como están, para que no haya dos maneras de escribir la misma.
 *
 * Nada de aquí toca la base ni falla hacia fuera: si no se puede leer, se
 * devuelve la ficha vacía.
 */

/** Cuántos párrafos se leen: la portada, y algo más por si va tras un índice. */
const PARRAFOS = 120;

/** El grado se mira solo en la portada: una «tesis doctoral» citada en las referencias no cuenta. */
const PORTADA = 30;

/** Palabras en mayúsculas del nombre del archivo que no son siglas de universidad. */
const NO_SIGLAS = new Set([
  'APA', 'ISO', 'IEEE', 'DOCX', 'DOC', 'PDF', 'FINAL', 'TESIS', 'FORMATO', 'PROYECTO', 'INFORME',
  'PLANTILLA', 'GUIA', 'MODELO', 'ESQUEMA', 'ESTRUCTURA', 'PREGRADO', 'POSGRADO', 'MAESTRIA',
  'DOCTORADO', 'COPIA', 'NUEVO', 'NUEVA', 'VERSION', 'TSP', 'TRABAJO', 'INVESTIGACION', 'PARA',
  'CON', 'DEL', 'LOS', 'LAS', 'POR', 'UNA', 'SUS', 'FACULTAD', 'ESCUELA', 'ARTICULO', 'CIENTIFICO', 'TITULO', 'GRADO',
  'VARIABLE', 'ACTUAL', 'CORREGIDO', 'CORREGIDA', 'REVISADO', 'REVISADA', 'BORRADOR', 'AVANCE',
]);

/** Las que no cuentan para la sigla: «Universidad Nacional Mayor de San Marcos» → UNMSM. */
const SIN_INICIAL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'en']);

/** Las que van en minúscula al pasar un nombre de MAYÚSCULAS a normal. */
const MINUSCULAS = new Set([...SIN_INICIAL, 'a', 'o', 'u', 'para', 'por', 'con']);

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function desescapar(texto) {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (todo, codigo) => {
    if (codigo[0] === '#') {
      const numero = codigo[1] === 'x' || codigo[1] === 'X' ? parseInt(codigo.slice(2), 16) : Number(codigo.slice(1));
      return Number.isFinite(numero) ? String.fromCodePoint(numero) : todo;
    }
    return ENTIDADES[codigo.toLowerCase()] ?? todo;
  });
}

/** El texto de cada párrafo de un XML de Word, sin vacíos. */
function parrafosDe(xml) {
  const salida = [];
  for (const trozo of String(xml).split(/<\/w:p>/)) {
    let texto = '';
    for (const encaje of trozo.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      texto += encaje[1] !== undefined ? encaje[1] : ' ';
    }
    texto = desescapar(texto).replace(/\s+/g, ' ').trim();
    if (texto) salida.push(texto);
  }
  return salida;
}

/** Los párrafos de las cabeceras (a veces el nombre va ahí) y los del cuerpo. */
function textoDelDocx(buffer) {
  const zip = abrirZip(buffer);
  const leer = (nombre) => zip.getEntry(nombre)?.getData().toString('utf8') ?? '';
  const cabeceras = zip
    .getEntries()
    .map((e) => e.entryName)
    .filter((n) => /^word\/header\d*\.xml$/.test(n))
    .sort();
  return [...cabeceras.flatMap((n) => parrafosDe(leer(n))), ...parrafosDe(leer('word/document.xml')).slice(0, PARRAFOS)];
}

/** «UNIVERSIDAD NACIONAL MAYOR DE SAN MARCOS» → «Universidad Nacional Mayor de San Marcos». */
function comoNombre(texto) {
  const limpio = String(texto).replace(/\s+/g, ' ').trim();
  const letras = limpio.replace(/[^\p{L}]/gu, '');
  if (!letras || letras !== letras.toUpperCase()) return limpio;
  return limpio
    .toLowerCase()
    .split(' ')
    .map((p, i) => (i > 0 && MINUSCULAS.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
}

/** Lo que va detrás del nombre en la misma línea: «– Lima», «(UNMSM)», «"Decana de América"». */
function cortar(texto) {
  return texto.split(/\s+[–—-]\s+|\s*[(«"“,;:|]\s*/)[0].trim();
}

/** El primer párrafo corto que empieza así, ya recortado: los de la portada son líneas sueltas. */
function primero(parrafos, empieza, { palabras = 12 } = {}) {
  for (const p of parrafos) {
    const encaje = p.match(empieza);
    if (!encaje) continue;
    const nombre = cortar(p.slice(encaje.index));
    const cuantas = nombre.split(' ').length;
    if (cuantas >= 2 && cuantas <= palabras) return comoNombre(nombre);
  }
  return '';
}

/** «Universidad Nacional Mayor de San Marcos» → «UNMSM». */
function siglaDe(nombre) {
  return busqueda
    .normalizar(nombre)
    .split(' ')
    .filter((p) => p && !SIN_INICIAL.has(p))
    .map((p) => p[0].toUpperCase())
    .join('');
}

/** Las siglas escritas en mayúsculas en el nombre del archivo o entre paréntesis en la portada. */
function siglasEscritas(nombreArchivo, parrafos) {
  const base = String(nombreArchivo ?? '').replace(/\.docx?$/i, '');
  const vistas = [
    ...base.matchAll(/(?<![\p{L}])([A-ZÑ]{3,8})(?![\p{L}])/gu),
    ...parrafos.join(' ').matchAll(/\(([A-ZÑ]{3,8})\)/g),
  ].map((m) => m[1]);
  const quitarTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return [...new Set(vistas)].filter((s) => !NO_SIGLAS.has(quitarTildes(s)));
}

/** Pregrado o posgrado solo si la portada lo dice claro y no dice los dos. */
function gradoDe(parrafos) {
  const texto = busqueda.normalizar(parrafos.join(' '));
  const pos = /\b(maestria|maestro|magister|doctorado|doctor en|doctora en|escuela de posgrado|posgrado|segunda especialidad)\b/.test(texto);
  const pre = /\b(titulo profesional|bachiller|licenciad[oa]|pregrado)\b/.test(texto);
  if (pos && !pre) return 'posgrado';
  if (pre && !pos) return 'pregrado';
  return '';
}

/**
 * La ficha propuesta para ese .docx. `biblioteca` son las filas ya aprobadas,
 * para reutilizar el nombre que ya tiene la universidad.
 *
 * Devuelve `{ universidad, alias, facultad, grado }`, con '' en lo que no se
 * encontró.
 */
function sugerir(buffer, nombreArchivo = '', biblioteca = []) {
  let parrafos = [];
  try {
    parrafos = textoDelDocx(buffer);
  } catch {
    parrafos = [];
  }

  const universidad = primero(parrafos, /^(pontificia\s+)?universidad\b/i, { palabras: 10 });
  const facultad =
    primero(parrafos, /^facultad\s+de\b/i) || primero(parrafos, /^escuela\s+(profesional|acad[eé]mico[\s-]+profesional)\s+de\b/i);
  const siglas = siglasEscritas(nombreArchivo, parrafos);

  // Si ya está en la biblioteca, con su nombre y sus otros nombres de allí.
  const yaEsta =
    (universidad && biblioteca.find((f) => busqueda.coincide(f, universidad))) ||
    siglas.map((s) => biblioteca.find((f) => busqueda.coincide(f, s))).find(Boolean);
  if (yaEsta) {
    return { universidad: yaEsta.universidad, alias: yaEsta.alias ?? '', facultad, grado: gradoDe(parrafos.slice(0, PORTADA)) };
  }

  // La sigla que corresponde al nombre leído va primero; si no hay nombre, solo las siglas.
  const propia = universidad ? siglaDe(universidad) : '';
  const alias = [...siglas.filter((s) => s === propia), ...siglas.filter((s) => s !== propia)];
  return { universidad, alias: alias.join(', '), facultad, grado: gradoDe(parrafos.slice(0, PORTADA)) };
}

module.exports = { sugerir, parrafosDe, comoNombre, siglaDe };
