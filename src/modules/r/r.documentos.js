'use strict';

/**
 * La matriz armada desde muchos informes en PDF.
 *
 * POR QUÉ EXISTE
 * --------------
 * Hay tesistas que no tienen una matriz: tienen una carpeta con un PDF por
 * caso. El primero que llegó (6-oct-2026) traía 80 informes de laboratorio de
 * caballos, el hemograma y la bioquímica de cada uno. El enlace de subida solo
 * aceptaba un Excel, un CSV o un SPSS, así que le quedaba pasar unos 2000
 * números a mano o pedírselos a Claude, que lee los PDF pero puede saltarse o
 * cambiar uno sin que nadie lo note.
 *
 * Esos PDF los escribe una máquina: tienen texto de verdad y cada fila de
 * resultados es «nombre · valor · unidad · rango». Aquí se leen con código, sin
 * modelo de por medio, y se arma una fila por caso y una columna por variable.
 *
 * QUÉ LEE
 * -------
 * Cualquier informe con filas «ETIQUETA  valor» (laboratorio clínico o
 * veterinario, análisis de suelo, de agua, de alimentos…), no un formato
 * concreto: las celdas se reconstruyen por su posición en la página. De la
 * cabecera solo se queda lo que sirve para analizar —fecha, edad, sexo,
 * especie, raza y peso—; el nombre, el dueño, el médico, el teléfono, la
 * dirección o el documento no entran nunca en la matriz.
 *
 * CÓMO JUNTA LOS ARCHIVOS DE UN MISMO CASO
 * ---------------------------------------
 * Por el nombre del archivo («CAB 01.pdf» y «CAB01.pdf» son el mismo caso), o
 * por la carpeta si cada caso tiene la suya. Si dos informes del mismo caso
 * traen la misma variable con valores distintos, son dos tomas y salen en dos
 * filas.
 *
 * Lo que no pudo leer, lo que no cuadra y lo que quitó va en `revisar` y en
 * `origen`, para que Claude lo confirme con el tesista antes de analizar.
 */

const path = require('node:path');
const AdmZip = require('adm-zip');

const { ArchivoNoValido, ordenDeLecturaCsv } = require('./r.formato');

/** Más archivos que esto no es una tesis: es otra cosa. */
const MAXIMO_ARCHIVOS = 500;
/** Un informe de resultados ocupa una o dos páginas; las demás son anexos. */
const MAXIMO_PAGINAS = 6;
/** Lo que puede ocupar el .zip descomprimido: un .zip de 1 MB puede abrir 10 GB. */
const MAXIMO_DESCOMPRIMIDO = 300 * 1024 * 1024;
/** Dos textos a menos de esto en vertical están en la misma fila del informe. */
const MISMA_FILA = 3;

// ── Qué se subió ────────────────────────────────────────────────────────────

function esPdf(bytes) {
  // Un .zip sin comprimir lleva su primer PDF a los pocos bytes: no es un PDF suelto.
  if (esZip(bytes)) return false;
  // La marca va al principio, pero hay generadores que meten basura delante.
  return bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

function esZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Lo que el sistema de archivos mete solo y nadie quiso subir. */
function esBasura(ruta) {
  const partes = ruta.split('/');
  return partes.some((p) => p === '__MACOSX' || p.startsWith('.')) || /^(thumbs\.db|desktop\.ini)$/i.test(partes.at(-1));
}

/**
 * Los PDF de un .zip, o null si el .zip es otra cosa (un Excel o un Word, que
 * también son .zip por dentro).
 */
function pdfsDelZip(bytes) {
  let zip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return null;
  }

  let entradas;
  try {
    entradas = zip.getEntries();
  } catch {
    return null;
  }
  if (entradas.some((e) => e.entryName === '[Content_Types].xml')) return null;

  const archivos = entradas.filter((e) => !e.isDirectory && !esBasura(e.entryName.replace(/\\/g, '/')));
  const pdfs = archivos.filter((e) => /\.pdf$/i.test(e.entryName));
  const otros = archivos.filter((e) => !/\.pdf$/i.test(e.entryName)).map((e) => path.posix.basename(e.entryName));

  return { zip, pdfs, otros };
}

/** ¿Es un PDF suelto o un .zip con PDF dentro? Se mira antes de leer nada. */
function esLote(bytes) {
  if (esPdf(bytes)) return true;
  if (!esZip(bytes)) return false;
  const dentro = pdfsDelZip(bytes);
  return dentro !== null && (dentro.pdfs.length > 0 || dentro.otros.length > 0);
}

function archivosDelLote(bytes) {
  if (esPdf(bytes)) return { archivos: [{ ruta: 'documento.pdf', bytes }], otros: [] };

  const dentro = pdfsDelZip(bytes);
  if (!dentro) return null;

  if (dentro.pdfs.length === 0) {
    const hojas = dentro.otros.filter((n) => /\.(xlsx|xls|csv|sav)$/i.test(n));
    throw new ArchivoNoValido(
      hojas.length > 0
        ? 'Ahí vienen varias hojas de cálculo. Por ahora se sube una sola matriz: júntalas en un ' +
            'Excel, una fila por persona, y súbelo. (Varios PDF sí se pueden subir a la vez.)'
        : 'En lo que subiste no hay ningún PDF ni ninguna hoja de datos.',
    );
  }
  if (dentro.pdfs.length > MAXIMO_ARCHIVOS) {
    throw new ArchivoNoValido(
      `Son ${dentro.pdfs.length} PDF y el máximo es ${MAXIMO_ARCHIVOS}. Súbelos en dos tandas o ` +
        'pregunta en tu conversación cómo seguir.',
    );
  }
  const total = dentro.pdfs.reduce((suma, e) => suma + (e.header.size || 0), 0);
  if (total > MAXIMO_DESCOMPRIMIDO) {
    throw new ArchivoNoValido('Los PDF ocupan demasiado una vez descomprimidos. Súbelos en dos tandas.');
  }

  return {
    archivos: dentro.pdfs.map((e) => ({ ruta: e.entryName.replace(/\\/g, '/'), bytes: e.getData() })),
    otros: dentro.otros,
  };
}

// ── Del PDF a filas de celdas ───────────────────────────────────────────────

const limpiar = (texto) => String(texto).replace(/\s+/g, ' ').trim();

/**
 * Las filas de texto de un PDF, cada una con sus celdas de izquierda a derecha.
 *
 * Sin posiciones, el texto de un PDF sale en el orden en que se dibujó, que no
 * tiene por qué ser el de lectura: en el hemograma del VetScan los títulos de
 * los histogramas salen en medio de los resultados.
 */
async function filasDe(bytes) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const filas = [];
  let primera = null;

  try {
    const paginas = Math.min(pdf.numPages, MAXIMO_PAGINAS);
    for (let p = 1; p <= paginas; p += 1) {
      const pagina = await pdf.getPage(p);
      const { items } = await pagina.getTextContent();
      const textos = items
        .filter((i) => typeof i.str === 'string' && i.str.trim())
        .map((i) => ({ texto: limpiar(i.str), x: i.transform[4], y: i.transform[5] }))
        .sort((a, b) => b.y - a.y || a.x - b.x);

      let actual = null;
      for (const t of textos) {
        if (!actual || Math.abs(actual.y - t.y) > MISMA_FILA) {
          actual = { y: t.y, celdas: [] };
          filas.push(actual);
        }
        actual.celdas.push(t);
      }
      if (p === 1 && textos.length > 0) primera = textos[0].texto;
    }
  } finally {
    await pdf.destroy?.();
  }

  return {
    filas: filas.map((f) => f.celdas.sort((a, b) => a.x - b.x).map((c) => c.texto)),
    encabezado: primera,
  };
}

// ── Resultados: «ETIQUETA  valor» ───────────────────────────────────────────

const NUMERO = /^([<>≤≥]?)\s*(-?\d+(?:[.,]\d+)?)\s*([+\-*↑↓]|\(?[HLAB]\)?)?$/;
const MARCA = /^([+\-*↑↓]|\(?[HLAB]\)?)$/;
const UNIDAD =
  /^(%|‰|fl|fL|pg|g|kg|mg|µg|ug|ng|ml|mL|l|L|dl|dL|µl|µL|ul|uL|cc|mm|cm|m|s|seg|min|h|°C|ppm|ppb|UI|U|IU|mEq|meq|mOsm|10\S*|[µu]?[a-zA-Zµ]{1,5}\s*\/\s*[a-zA-Zµ0-9³]{1,4}(?:\s*\/\s*[a-zA-Z]{1,3})?)$/;

/** Una etiqueta de resultado: corta, con letras, y que no sea una unidad. */
function esEtiqueta(texto) {
  if (texto.length > 40 || !/\p{L}/u.test(texto) || /:/.test(texto)) return false;
  if (!/^[#*]?[\p{L}µ]/u.test(texto)) return false;
  if (texto.split(' ').length > 5) return false;
  return !UNIDAD.test(texto) && !/^Ű/.test(texto);
}

/**
 * Los resultados de una fila. Normalmente uno («GLU · 85 · mg/dL · 63-136»),
 * pero hay informes con dos columnas de analitos lado a lado.
 */
function resultadosDe(celdasOriginales) {
  const celdas = celdasOriginales.flatMap((c, i) => {
    // «0.60 ml»: el valor y la unidad en la misma celda.
    const conUnidad = /^([<>≤≥]?-?\d+(?:[.,]\d+)?)\s+(\S.*)$/.exec(c);
    if (conUnidad && UNIDAD.test(conUnidad[2])) return [conUnidad[1], conUnidad[2]];
    // «LEU 7.43» en una sola celda, como lo escriben algunos equipos. Pero si
    // lo que sigue ya es un número, el número es parte del nombre: «Lisis 2 · 3.50».
    const junto = /^(.+?)\s+([<>≤≥]?-?\d+(?:[.,]\d+)?)$/.exec(c);
    const siguiente = celdasOriginales[i + 1] ?? '';
    const sigueNumero = !UNIDAD.test(siguiente) && /^[<>≤≥]?-?\d+(?:[.,]\d+)?(?:\s+\S+)?$/.test(siguiente);
    return junto && esEtiqueta(junto[1]) && !sigueNumero ? [junto[1], junto[2]] : [c];
  });

  // Una fila con «:» es de la cabecera («Fecha : 23/03/2025»), no un resultado.
  if (celdas.some((c) => c.includes(':'))) return [];

  const hallados = [];
  for (let i = 0; i < celdas.length; i += 1) {
    if (!esEtiqueta(celdas[i])) continue;
    let j = i + 1;
    while (j < celdas.length && MARCA.test(celdas[j])) j += 1;
    const numero = NUMERO.exec(celdas[j] ?? '');
    if (!numero) continue;

    let k = j + 1;
    while (k < celdas.length && MARCA.test(celdas[k])) k += 1;
    hallados.push({
      etiqueta: celdas[i],
      valor: numero[1] ? null : Number(numero[2].replace(',', '.')),
      fueraDeMedicion: Boolean(numero[1]),
      unidad: celdas[k] && UNIDAD.test(celdas[k]) ? celdas[k] : null,
    });
    i = k - 1;
  }
  return hallados;
}

// ── La cabecera: lo que se queda y lo que no ────────────────────────────────

/** Quita las tildes sin cambiar la longitud, para poder cortar el original. */
const plegar = (texto) =>
  [...texto]
    .map((c) => c.normalize('NFD')[0])
    .join('')
    .toLowerCase();

/**
 * Las etiquetas de cabecera que se reconocen, de la más larga a la más corta.
 * Las de `quitar` se leen solo para saber dónde acaban y se tiran.
 */
const CABECERA = [
  ['quitar', 'nombre (?:del )?(?:medico|veterinario|doctor)'],
  ['quitar', 'nombre (?:del )?(?:dueno|propietario|tutor)'],
  ['quitar', 'direc(?:cion|\\.)(?: del (?:hospital|dueno|paciente))?|direc\\. dueno|domicilio'],
  ['quitar', 'telefono(?: del (?:hospital|dueno))?|celular|tel\\.'],
  ['quitar', 'f\\. ?nacimiento|fecha de nacimiento|fecha del informe|fecha de (?:impresion|emision)'],
  ['quitar', 'n\\.?\\s?[ºo°]\\.? de serie|numero de serie|version de software'],
  ['quitar', 'id\\.? de la muestra|n\\.?\\s?[ºo°]\\.? de muestra|codigo de muestra'],
  ['quitar', 'medico|veterinario|doctor|dueno|propietario|tutor|dni|documento|correo|e-?mail'],
  ['paciente', 'id\\.? del pac(?:iente|\\.)|nombre (?:del )?pac(?:iente|\\.)|historia clinica|paciente'],
  ['paciente', 'nombre'],
  ['fecha', 'fecha de (?:la )?(?:prueba|toma|muestra|analisis|muestreo)|fecha'],
  ['edad', 'edad'],
  ['sexo', 'sexo|genero'],
  ['especie', 'especies?'],
  ['raza', 'raza'],
  ['peso', 'peso'],
];
const ETIQUETA_DE_CABECERA = new RegExp(
  `(?<![\\p{L}\\p{N}])(${CABECERA.map(([, r]) => r).join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);
const UNA_ETIQUETA = CABECERA.map(([clave, r]) => [clave, new RegExp(`^(?:${r})$`, 'u')]);

/** Parte las celdas por las etiquetas conocidas y por los «:» que no son una hora. */
function trozosDe(celdas) {
  const trozos = [];
  for (const celda of celdas) {
    for (const parte of celda.split(/(?<!\d)\s*:\s*|\s*:\s*(?!\d)/)) {
      if (trozos.length > 0 || parte) trozos.push({ tipo: 'texto', texto: parte });
      trozos.push({ tipo: 'dos-puntos' });
    }
    trozos.pop();
  }

  // Ahora las etiquetas conocidas que van pegadas a un valor: «02714 Nombre».
  const final = [];
  for (const t of trozos) {
    if (t.tipo !== 'texto') {
      final.push(t);
      continue;
    }
    const plegado = plegar(t.texto);
    let desde = 0;
    for (const m of plegado.matchAll(ETIQUETA_DE_CABECERA)) {
      const antes = t.texto.slice(desde, m.index).trim();
      if (antes) final.push({ tipo: 'texto', texto: antes });
      const clave = UNA_ETIQUETA.find(([, r]) => r.test(m[1]))?.[0] ?? 'quitar';
      final.push({ tipo: 'etiqueta', clave, texto: t.texto.slice(m.index, m.index + m[1].length) });
      desde = m.index + m[1].length;
    }
    const resto = t.texto.slice(desde).trim();
    if (resto) final.push({ tipo: 'texto', texto: resto });
  }
  return final;
}

/**
 * Los campos de cabecera de una fila: `{ clave, valor, etiqueta }`.
 *
 * El valor de una etiqueta son los textos que la siguen hasta la siguiente
 * etiqueta. Un texto seguido de «:» que no está en la lista también es una
 * etiqueta («Toma medicinas :»): sin eso, la raza sería «CPP Toma medicinas».
 */
function camposDe(celdas) {
  const trozos = trozosDe(celdas).filter((t) => t.tipo !== 'texto' || t.texto.replace(/^[.\s]+/, ''));
  const campos = [];
  for (let i = 0; i < trozos.length; i += 1) {
    const t = trozos[i];
    if (t.tipo !== 'etiqueta') continue;
    const valor = [];
    let j = i + 1;
    if (trozos[j]?.tipo === 'dos-puntos') j += 1;
    for (; j < trozos.length; j += 1) {
      if (trozos[j].tipo !== 'texto') break;
      if (trozos[j + 1]?.tipo === 'dos-puntos') break;
      valor.push(trozos[j].texto.replace(/^[.\s]+/, ''));
    }
    campos.push({ clave: t.clave, etiqueta: t.texto, valor: limpiar(valor.join(' ')) });
    i = j - 1;
  }
  return campos;
}

/** dd/mm/aaaa, dd-mm-aaaa o aaaa-mm-dd → aaaa-mm-dd. */
function fechaIso(texto) {
  let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(texto);
  if (m) return valida(m[1], m[2], m[3]);
  m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(texto);
  if (m) return valida(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  return null;

  function valida(a, mes, d) {
    if (Number(mes) < 1 || Number(mes) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
}

/** «3 a», «3 años», «18 meses», «2 a 6 m» → años con dos decimales. */
function edadEnAnios(texto) {
  const t = plegar(texto);
  let anios = 0;
  let hubo = false;
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(anos?|a\b|y\b|years?|meses|mes|m\b|months?|semanas?|sem|s\b|dias?|d\b)?/g)) {
    const n = Number(m[1].replace(',', '.'));
    const unidad = m[2] ?? 'a';
    hubo = true;
    if (/^(m|mes|meses|months?)$/.test(unidad)) anios += n / 12;
    else if (/^(s|sem|semanas?)$/.test(unidad)) anios += n / 52;
    else if (/^(d|dias?)$/.test(unidad)) anios += n / 365;
    else anios += n;
  }
  return hubo ? Math.round(anios * 100) / 100 : null;
}

/** Lo que vale de cada campo, o null si no tiene la forma que debe. */
function valorDeCampo(clave, valor) {
  if (!valor) return null;
  if (clave === 'fecha') return fechaIso(valor);
  if (clave === 'edad') return edadEnAnios(valor);
  if (clave === 'peso') {
    const m = /(\d+(?:[.,]\d+)?)/.exec(valor);
    return m ? Number(m[1].replace(',', '.')) : null;
  }
  return valor.length <= 30 ? valor : null;
}

// ── Un informe ──────────────────────────────────────────────────────────────

async function leerInforme({ ruta, bytes }) {
  const informe = { ruta, medidas: new Map(), campos: {}, quitados: new Set(), sinTexto: false, encabezado: null };

  let leido;
  try {
    leido = await filasDe(bytes);
  } catch {
    informe.ilegible = true;
    return informe;
  }
  informe.encabezado = leido.encabezado;
  if (leido.filas.length === 0) {
    informe.sinTexto = true;
    return informe;
  }

  for (const celdas of leido.filas) {
    const resultados = resultadosDe(celdas);
    if (resultados.length > 0) {
      for (const r of resultados) {
        // La primera vez que aparece manda: en la segunda página suele estar
        // repetido en el gráfico de seguimiento.
        if (!informe.medidas.has(r.etiqueta)) informe.medidas.set(r.etiqueta, r);
      }
      continue;
    }
    for (const campo of camposDe(celdas)) {
      if (campo.clave === 'quitar') {
        if (campo.valor) informe.quitados.add(plegar(campo.etiqueta).replace(/[.:\s]+$/, ''));
        continue;
      }
      const valor = valorDeCampo(campo.clave, campo.valor);
      if (valor !== null && !(campo.clave in informe.campos)) informe.campos[campo.clave] = valor;
    }
  }
  return informe;
}

// ── Los casos: qué archivos son del mismo ───────────────────────────────────

/** Palabras que dicen qué informe es y no de quién: «hemograma CAB01» y «bioquímica CAB01». */
const TIPO_DE_INFORME =
  /\b(hemograma|hemo|bioquimica|bioq|bq|quimica|perfil|analisis|resultados?|informe|reporte|examen|laboratorio|lab|orina|heces|serologia|copia)\b/g;

function claveDeNombre(nombre) {
  // El guion bajo separa palabras: sin esto, en «CAB01_hemograma» la palabra
  // queda pegada al código y no se quita, y no se junta con «CAB01_bioquimica».
  const base = plegar(nombre.replace(/\.pdf$/i, ''))
    .replace(/_/g, ' ')
    .replace(TIPO_DE_INFORME, ' ');
  const clave = base.replace(/[^a-z0-9]+/g, '').replace(/\d+/g, (n) => String(Number(n)));
  return clave || plegar(nombre).replace(/[^a-z0-9]+/g, '');
}

/**
 * El código de caso dentro del nombre: «P-003 Perfil lipídico» → P-003.
 * Respaldo para cuando cada informe se llama distinto y el nombre entero no
 * junta nada.
 */
function codigoDeNombre(nombre) {
  const plegado = plegar(nombre.replace(/\.pdf$/i, ''));
  const m = /([a-z]{0,6})[\s_\-.#]*(\d+)/.exec(plegado);
  if (!m) return null;
  return {
    clave: `${m[1]}${Number(m[2])}`,
    id: nombre.slice(m.index, m.index + m[0].length).trim(),
  };
}

/** El nombre que se ve: el del archivo sin la extensión, o el de la carpeta. */
function nombreSinPdf(ruta) {
  const nombre = path.posix.basename(ruta).replace(/\.pdf$/i, '').trim();
  // «CAB01_hemograma» → CAB01: el caso, sin la palabra de qué informe es.
  // Se busca en la copia sin tildes, que tiene la misma longitud que el original.
  const plegado = plegar(nombre).replace(/_/g, ' ');
  let sinTipo = '';
  let desde = 0;
  for (const m of plegado.matchAll(TIPO_DE_INFORME)) {
    sinTipo += nombre.slice(desde, m.index);
    desde = m.index + m[0].length;
  }
  sinTipo = (sinTipo + nombre.slice(desde)).replace(/^[\s_\-.]+|[\s_\-.]+$/g, '').replace(/[\s_\-.]{2,}/g, ' ');
  return sinTipo || nombre;
}

function agrupar(informes) {
  // Lo que todas las rutas comparten delante («data/»): elegir una carpeta la trae.
  const partes = informes.map((i) => i.ruta.split('/').slice(0, -1));
  let comun = 0;
  while (partes.every((p) => p.length > comun && p[comun] === partes[0][comun])) comun += 1;
  const carpetaDe = (i) => i.ruta.split('/').slice(comun, -1).join('/');

  // Una carpeta por caso: varias carpetas, y en cada una más de un informe o
  // los mismos nombres repetidos de una carpeta a otra.
  const carpetas = new Set(informes.map(carpetaDe));
  const porCarpeta = carpetas.size > 1 && !carpetas.has('') && carpetas.size < informes.length;

  const juntar = (claveDe) => {
    const grupos = new Map();
    for (const informe of informes) {
      const { clave, id } = claveDe(informe);
      if (!grupos.has(clave)) grupos.set(clave, { id, informes: [] });
      grupos.get(clave).informes.push(informe);
    }
    return [...grupos.values()];
  };

  let por = porCarpeta ? 'carpeta' : 'nombre';
  let grupos = porCarpeta
    ? juntar((i) => ({ clave: carpetaDe(i), id: carpetaDe(i).split('/').at(-1) }))
    : juntar((i) => ({ clave: claveDeNombre(path.posix.basename(i.ruta)), id: nombreSinPdf(i.ruta) }));

  // Si por el nombre no se juntó nada, se prueba con el código que lleva dentro.
  if (!porCarpeta && grupos.length === informes.length && informes.length > 1) {
    const codigos = informes.map((i) => codigoDeNombre(path.posix.basename(i.ruta)));
    if (codigos.every(Boolean)) {
      const porCodigo = juntar((i) => codigos[informes.indexOf(i)]);
      if (porCodigo.length < grupos.length) {
        grupos = porCodigo;
        por = 'codigo';
      }
    }
  }

  const ordenados = grupos.sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true, sensitivity: 'base' }));
  return { grupos: ordenados, por };
}

/**
 * Las filas de un caso. Un informe va a la primera toma con la que no choca;
 * si choca con todas —la misma variable con otro valor—, es una toma nueva.
 */
function tomasDe(grupo, conflictos) {
  const informes = [...grupo.informes].sort(
    (a, b) =>
      String(a.campos.fecha ?? '').localeCompare(String(b.campos.fecha ?? '')) ||
      a.ruta.localeCompare(b.ruta, 'es', { numeric: true }),
  );
  const tomas = [];
  for (const informe of informes) {
    const choca = (toma) =>
      [...informe.medidas].some(([e, r]) => toma.medidas.has(e) && toma.medidas.get(e).valor !== r.valor);
    let toma = tomas.find((t) => !choca(t));
    if (!toma) {
      toma = { medidas: new Map(), campos: {}, archivos: [] };
      tomas.push(toma);
    }
    for (const [e, r] of informe.medidas) if (!toma.medidas.has(e)) toma.medidas.set(e, r);
    for (const [c, v] of Object.entries(informe.campos)) {
      if (!(c in toma.campos)) toma.campos[c] = v;
      else if (c !== 'fecha' && c !== 'paciente' && toma.campos[c] !== v) {
        // Por campo y par de valores, no por caso: «Caballo» y «Equino» en los
        // 40 caballos es UN aviso, no cuarenta.
        const clave = `${c} «${toma.campos[c]}» en un informe y «${v}» en otro`;
        conflictos.set(clave, (conflictos.get(clave) ?? 0) + 1);
      }
    }
    toma.archivos.push(path.posix.basename(informe.ruta));
  }
  return tomas;
}

// ── La matriz ───────────────────────────────────────────────────────────────

const RESERVADAS = new Set(['id', 'toma', 'fecha', 'edad_anios', 'sexo', 'especie', 'raza', 'peso_kg', 'archivos']);

/** «LYM%» → LYM_pct, «#A/G» → A_G, «Glucosa (ayunas)» → Glucosa_ayunas. */
function nombreDeColumna(etiqueta, usados) {
  // Las tildes fuera pero las mayúsculas se quedan: «HCT» no es «hct» para quien lo lee.
  let nombre = [...etiqueta.replace(/^[#*]+/, '')]
    .map((c) => c.normalize('NFD')[0])
    .join('')
    .replace(/%/g, '_pct')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!nombre) nombre = 'variable';
  if (/^\d/.test(nombre)) nombre = `x${nombre}`;

  let final = nombre;
  for (let n = 2; usados.has(final.toLowerCase()) || RESERVADAS.has(final.toLowerCase()); n += 1) final = `${nombre}_${n}`;
  usados.add(final.toLowerCase());
  return final;
}

function celdaCsv(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'number') return String(valor);
  const texto = String(valor);
  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

const COMO_SE_JUNTO = {
  carpeta: { corto: 'la carpeta', largo: 'la carpeta en la que estaban' },
  nombre: { corto: 'el nombre del archivo', largo: 'el nombre del archivo («CAB 01» y «CAB01» son el mismo)' },
  codigo: { corto: 'el código del nombre del archivo', largo: 'el código que lleva el nombre del archivo («P-003 hemograma» y «P-003 bioquímica»)' },
};

const plural = (n, palabra) => `${n} ${palabra}${n === 1 ? '' : 's'}`;
const casos = (n) => (n === 1 ? '1 caso' : `${n} casos`);

const lista = (cosas, maximo = 8) =>
  cosas.length <= maximo ? cosas.join(', ') : `${cosas.slice(0, maximo).join(', ')} y ${cosas.length - maximo} más`;

/**
 * Lee todos los informes y arma la matriz. Devuelve lo mismo que
 * `r.formato.preparar`, más `revisar` (para la página) y `origen` (para Claude).
 */
async function armar(archivos, otros) {
  const informes = [];
  for (const archivo of archivos) informes.push(await leerInforme(archivo));

  const leidos = informes.filter((i) => i.medidas.size > 0);
  const sinTexto = informes.filter((i) => i.sinTexto).map((i) => path.posix.basename(i.ruta));
  const ilegibles = informes.filter((i) => i.ilegible).map((i) => path.posix.basename(i.ruta));
  const sinResultados = informes
    .filter((i) => !i.sinTexto && !i.ilegible && i.medidas.size === 0)
    .map((i) => path.posix.basename(i.ruta));

  if (leidos.length === 0) {
    throw new ArchivoNoValido(
      sinTexto.length === informes.length
        ? 'Tus PDF son imágenes escaneadas o fotos: no traen texto que se pueda leer. Si el equipo o ' +
            'el laboratorio te los puede dar en PDF original (el que sale del programa), súbelos así; ' +
            'si no, pásalos a un Excel, una fila por caso, y sube ese Excel.'
        : 'No se encontraron resultados en esos PDF: ninguna fila con el nombre de una variable y su ' +
            'valor. Sube tu matriz en Excel (una fila por caso) o pregunta en tu conversación.',
    );
  }

  const { grupos, por } = agrupar(leidos);
  const conflictos = new Map();
  const filas = grupos.flatMap((g) => tomasDe(g, conflictos).map((t, n, todas) => ({ id: g.id, toma: n + 1, varias: todas.length > 1, ...t })));

  // Las columnas de resultados, en el orden en que aparecen por primera vez.
  const etiquetas = [];
  const unidades = new Map();
  for (const informe of leidos) {
    for (const [e, r] of informe.medidas) {
      if (!unidades.has(e)) {
        etiquetas.push(e);
        unidades.set(e, r.unidad);
      }
    }
  }
  const usados = new Set();
  const columnas = etiquetas.map((e) => ({ etiqueta: e, nombre: nombreDeColumna(e, usados), unidad: unidades.get(e) }));

  const hay = (campo) => filas.some((f) => f.campos[campo] !== undefined);
  const conToma = filas.some((f) => f.varias);
  const cabecera = [
    ['id', (f) => f.id],
    ...(conToma ? [['toma', (f) => f.toma]] : []),
    ...(hay('fecha') ? [['fecha', (f) => f.campos.fecha]] : []),
    ...(hay('edad') ? [['edad_anios', (f) => f.campos.edad]] : []),
    ...(hay('sexo') ? [['sexo', (f) => f.campos.sexo]] : []),
    ...(hay('especie') ? [['especie', (f) => f.campos.especie]] : []),
    ...(hay('raza') ? [['raza', (f) => f.campos.raza]] : []),
    ...(hay('peso') ? [['peso_kg', (f) => f.campos.peso]] : []),
    ...columnas.map((c) => [c.nombre, (f) => f.medidas.get(c.etiqueta)?.valor ?? null]),
    ['archivos', (f) => f.archivos.join(' + ')],
  ];

  const csv = [
    cabecera.map(([n]) => n).join(','),
    ...filas.map((f) => cabecera.map(([, valor]) => celdaCsv(valor(f))).join(',')),
  ].join('\n');

  // ── Lo que hay que revisar ──
  const vacios = columnas
    .map((c) => ({ c, n: filas.filter((f) => !f.medidas.has(c.etiqueta) || f.medidas.get(c.etiqueta).valor === null).length }))
    .filter(({ n }) => n > 0);
  const fueraDeMedicion = filas.reduce(
    (suma, f) => suma + [...f.medidas.values()].filter((r) => r.fueraDeMedicion).length,
    0,
  );
  const archivosPorFila = filas.map((f) => f.archivos.length);
  const habitual = moda(archivosPorFila);
  const incompletos = filas.filter((f) => f.archivos.length < habitual).map((f) => f.id);
  const quitados = [...new Set(informes.flatMap((i) => [...i.quitados]))];
  const constantes = columnas
    .filter((c) => filas.length >= 5 && new Set(filas.map((f) => f.medidas.get(c.etiqueta)?.valor)).size === 1)
    .map((c) => c.etiqueta);

  const revisar = [];
  if (sinTexto.length > 0) revisar.push(`${sinTexto.length} PDF son imágenes escaneadas y no se pudieron leer: ${lista(sinTexto)}.`);
  if (ilegibles.length > 0) revisar.push(`${ilegibles.length} PDF están dañados o con contraseña: ${lista(ilegibles)}.`);
  if (sinResultados.length > 0) revisar.push(`En ${sinResultados.length} PDF no se encontró ningún resultado: ${lista(sinResultados)}.`);
  if (incompletos.length > 0 && habitual > 1) {
    revisar.push(
      `Casi todos los casos tienen ${habitual} informes, pero ${incompletos.length === 1 ? '1 tiene' : `${incompletos.length} tienen`} menos: ${lista(incompletos)}. ` +
        'Si el informe que falta está en otro archivo, nómbralo igual que los demás de ese caso.',
    );
  }
  if (fueraDeMedicion > 0) revisar.push(`${fueraDeMedicion} valores venían como «<» o «>» (fuera del rango del equipo) y quedaron vacíos.`);
  if (conflictos.size > 0) {
    const cuales = [...conflictos].map(([texto, n]) => `${texto} (${casos(n)})`);
    revisar.push(`Datos que no coinciden entre los informes de un mismo caso: ${lista(cuales, 5)}. Quedó el primero.`);
  }
  if (otros.length > 0) {
    revisar.push(`${otros.length === 1 ? 'Se ignoró 1 archivo que no es PDF' : `Se ignoraron ${otros.length} archivos que no son PDF`}: ${lista(otros, 5)}.`);
  }

  const juntados = filas.length < leidos.length;
  const resumen =
    `Se armó tu matriz con ${leidos.length} PDF: ${plural(filas.length, 'fila')} y ${plural(cabecera.length, 'columna')}.` +
    (juntados ? ` Los informes de cada caso se juntaron por ${COMO_SE_JUNTO[por].corto}.` : '') +
    (quitados.length > 0 ? ' Los datos personales (nombres, dueño, médico, teléfono…) no entraron.' : '');

  // Un tipo de informe por cada juego distinto de variables: así Claude sabe
  // de qué equipo o laboratorio sale cada columna.
  const tipos = new Map();
  for (const i of leidos) {
    const firma = [...i.medidas.keys()].sort().join('|');
    if (!tipos.has(firma)) tipos.set(firma, { encabezado: i.encabezado, variables: [...i.medidas.keys()], n: 0 });
    tipos.get(firma).n += 1;
  }

  const N = '\n';
  const origen = [
    `MATRIZ ARMADA POR EL SERVIDOR DESDE ${informes.length} INFORMES EN PDF: el tesista no subió una matriz, ` +
      'subió los PDF y el servidor los leyó con código, sin modelo de por medio.',
    `· ${plural(filas.length, 'fila')}: una por caso${conToma ? ' y por toma (columna «toma»: el mismo análisis repetido con otros valores)' : ''}. ` +
      (juntados
        ? `Los informes de cada caso se juntaron por ${COMO_SE_JUNTO[por].largo}; la columna «archivos» dice cuáles forman cada fila.`
        : 'Cada PDF es una fila.'),
    `· Tipos de informe: ${[...tipos.values()]
      .slice(0, 6)
      .map((t) => `${t.n} con ${t.variables.length} variables${t.encabezado ? ` (empieza «${t.encabezado.slice(0, 60)}»)` : ''}`)
      .join('; ')}.`,
    `· Variables y su unidad: ${columnas
      .slice(0, 80)
      .map((c) => (c.unidad ? `${c.nombre} (${c.unidad})` : c.nombre))
      .join(', ')}${columnas.length > 80 ? ` y ${columnas.length - 80} más` : ''}.`,
    quitados.length > 0
      ? `· NO ENTRARON, por ser datos personales o del equipo: ${lista(quitados, 12)}. El «id» es el nombre del archivo; si fuera el nombre de una persona, en la tesis usa códigos (P01, P02…).`
      : '· El «id» es el nombre del archivo; si fuera el nombre de una persona, en la tesis usa códigos.',
    vacios.length > 0 ? `· Columnas con vacíos: ${lista(vacios.map(({ c, n }) => `${c.nombre} (${n})`), 15)}.` : '· Ninguna columna de resultados tiene vacíos.',
    constantes.length > 0
      ? `· Valen lo mismo en todas las filas (probablemente datos del equipo, no del caso; no las analices sin preguntar): ${lista(constantes, 10)}.`
      : null,
    ...revisar.map((r) => `· REVISAR: ${r}`),
    'ANTES DE ANALIZAR, díselo en dos frases: cuántas filas y columnas salieron y lo de REVISAR, y pregúntale ' +
      'si cada fila es un caso de su estudio. Si quiere verla en Excel: escribir_csv(datos, "matriz-desde-pdf.csv") ' +
      'y dale el enlace con "descargar". En la Metodología se escribe que los valores se tomaron de los informes ' +
      'emitidos por el equipo o laboratorio; NUNCA que los transcribió el tesista ni una IA.',
  ]
    .filter(Boolean)
    .join(N);

  return {
    tipo: 'documentos',
    archivo: 'datos.csv',
    contenido: Buffer.from(csv, 'utf8'),
    lectura: ordenDeLecturaCsv({ separador: ',', decimal: '.', codificacion: 'UTF-8' }),
    aviso: resumen,
    revisar,
    origen,
    documentos: leidos.length,
  };
}

function moda(numeros) {
  const cuenta = new Map();
  for (const n of numeros) cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
  return [...cuenta].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1;
}

/** La matriz de un PDF suelto o de un .zip de PDF; null si no es nada de eso. */
async function preparar(bytes) {
  if (!esLote(bytes)) return null;
  const lote = archivosDelLote(bytes);
  if (!lote) return null;
  return armar(lote.archivos, lote.otros);
}

module.exports = {
  preparar,
  esLote,
  armar,
  // Para las pruebas.
  resultadosDe,
  camposDe,
  claveDeNombre,
  codigoDeNombre,
  nombreDeColumna,
  edadEnAnios,
  fechaIso,
  agrupar,
};
