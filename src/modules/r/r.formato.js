'use strict';

/**
 * Qué archivo subió el tesista y con qué orden lo lee R.
 *
 * Es lo que hacía la página de análisis al subir un archivo (ver `formatoDe` en
 * `features/analisis/analisis.ts` de la web), traído al servidor y con lo que
 * allí faltaba: el Excel de verdad (.xlsx y .xls), el archivo de SPSS (.sav) y
 * los CSV que Excel guarda en la codificación antigua de Windows.
 *
 * POR QUÉ HAY QUE MIRARLO
 * -----------------------
 * El Excel en español NO guarda los CSV con comas: usa punto y coma, porque la
 * coma ya hace de decimal. `read.csv()` a secas devuelve UNA columna con todo
 * dentro, sin error, y el análisis entero se construye encima de eso.
 *
 * Y «CSV (delimitado por comas)», que es la opción que sale primero en el Excel
 * de Windows, no escribe UTF-8: escribe la página de códigos de Windows. Leído
 * como UTF-8, R corta el archivo en la primera «ñ» y avisa en inglés.
 */

/** Los tres bytes con los que Excel marca un CSV en UTF-8. */
const BOM = [0xef, 0xbb, 0xbf];

const MUESTRA = 8192;

class ArchivoNoValido extends Error {}

function empiezaPor(bytes, firma) {
  return bytes.length >= firma.length && firma.every((b, i) => bytes[i] === b);
}

/**
 * xlsx, xls, sav, csv o null.
 *
 * Por los primeros bytes y no por la extensión: la extensión la pone quien sube
 * el archivo, y un .csv que en realidad es un .xlsx renombrado es de lo más
 * corriente.
 */
function tipoDe(bytes) {
  if (empiezaPor(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'xlsx';
  if (empiezaPor(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls';
  // «$FL2», o «$FL3» si SPSS lo guardó comprimido.
  if (empiezaPor(bytes, [0x24, 0x46, 0x4c, 0x32]) || empiezaPor(bytes, [0x24, 0x46, 0x4c, 0x33])) {
    return 'sav';
  }

  // Un texto no lleva bytes nulos. Un PDF, una imagen o un .docx sí.
  const muestra = bytes.subarray(0, MUESTRA);
  if (muestra.length > 0 && !muestra.includes(0x00)) return 'csv';
  return null;
}

function esUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Con qué separa las columnas: coma, punto y coma o tabulador.
 *
 * Se cuenta fuera de las comillas: una columna «Apellidos, nombre» entre
 * comillas tiene comas que no separan nada.
 */
function separadorDe(cabecera) {
  const cuenta = { ',': 0, ';': 0, '\t': 0 };
  let dentroDeComillas = false;

  for (const caracter of cabecera) {
    if (caracter === '"') dentroDeComillas = !dentroDeComillas;
    else if (!dentroDeComillas && caracter in cuenta) cuenta[caracter] += 1;
  }

  if (cuenta['\t'] > cuenta[','] && cuenta['\t'] > cuenta[';']) return '\t';
  return cuenta[';'] > cuenta[','] ? ';' : ',';
}

/**
 * Con qué escribe los decimales: «3.25» o «3,25».
 *
 * Solo puede haber coma decimal si las columnas NO van por comas. Leído con el
 * decimal equivocado, la columna entra como TEXTO: se ve bien, pero `mean()` se
 * niega tres pasos más tarde.
 */
function decimalDe(filas, separador) {
  if (separador === ',') return '.';
  return filas.some((fila) => /\d,\d/.test(fila)) ? ',' : '.';
}

/** Cómo está escrito un CSV, y cuántos bytes del principio no son datos. */
function formatoDeCsv(bytes) {
  let saltar = empiezaPor(bytes, BOM) ? BOM.length : 0;

  const codificacion = esUtf8(bytes) ? 'UTF-8' : 'latin1';
  const decodificador = new TextDecoder(codificacion === 'UTF-8' ? 'utf-8' : 'latin1');
  const muestra = decodificador.decode(bytes.subarray(saltar, saltar + MUESTRA));
  const lineas = muestra.split('\n').map((linea) => linea.replace(/\r$/, ''));

  // «sep=;» en la primera línea: Excel lo escribe y lo obedece, R no lo
  // entiende y se lo tragaría como la primera fila.
  const pista = /^sep=(.)\s*$/.exec(lineas[0] ?? '');
  const cuerpo = pista ? lineas.slice(1) : lineas;
  if (pista) {
    const salto = bytes.indexOf(0x0a, saltar);
    saltar = salto === -1 ? bytes.length : salto + 1;
  }

  const separador = pista ? (pista[1] === ';' ? ';' : pista[1] === '\t' ? '\t' : ',') : separadorDe(cuerpo[0] ?? '');

  return { separador, decimal: decimalDe(cuerpo.slice(1), separador), codificacion, saltar };
}

/** La orden de R que lee el CSV tal como está escrito. */
function ordenDeLecturaCsv({ separador, decimal, codificacion }) {
  const opciones = [];
  if (separador !== ',') opciones.push(`sep = "${separador === '\t' ? '\\t' : separador}"`);
  if (decimal !== '.') opciones.push(`dec = "${decimal}"`);
  if (codificacion !== 'UTF-8') opciones.push(`fileEncoding = "${codificacion}"`);

  return `datos <- read.csv("datos.csv"${opciones.map((o) => `, ${o}`).join('')})`;
}

/** Los nombres pasan por make.names como hace read.csv: sin esto, «Me gusta» obliga a comillas invertidas. */
const NOMBRES_LIMPIOS = 'names(datos) <- make.names(names(datos), unique = TRUE)';

/**
 * Todo lo que hace falta para meter el archivo en R.
 *
 * Devuelve el nombre con el que se guarda —SIEMPRE `datos.*`, se llame como se
 * llame el suyo: así la primera línea del guion no hay que editarla—, los bytes
 * que se guardan y la orden que lo lee.
 */
function preparar(bytes) {
  const tipo = tipoDe(bytes);

  if (tipo === 'xlsx' || tipo === 'xls') {
    const archivo = `datos.${tipo}`;
    return {
      tipo,
      archivo,
      contenido: bytes,
      lectura: `datos <- as.data.frame(readxl::read_excel("${archivo}"))\n${NOMBRES_LIMPIOS}`,
      aviso: null,
    };
  }

  if (tipo === 'sav') {
    return {
      tipo,
      archivo: 'datos.sav',
      contenido: bytes,
      // zap_labels y no as_factor: un ítem Likert etiquetado («Totalmente de
      // acuerdo» = 5) tiene que quedar como 5 para calcular el alfa o una media.
      // Con as_factor entraría como texto y ninguna prueba numérica funcionaría.
      lectura: `datos <- as.data.frame(haven::zap_labels(haven::read_sav("datos.sav")))\n${NOMBRES_LIMPIOS}`,
      aviso:
        'Es un archivo de SPSS. Se leyó con los números de cada respuesta y sin las etiquetas de ' +
        'valor, que es lo que necesitan las pruebas.',
    };
  }

  if (tipo === 'csv') {
    const formato = formatoDeCsv(bytes);
    const avisos = [];
    if (formato.separador === ';') {
      avisos.push(
        'El archivo separa las columnas con punto y coma —así las guarda el Excel en español— ' +
          (formato.decimal === ',' ? 'y escribe los decimales con coma.' : 'y los decimales con punto.'),
      );
    }
    if (formato.codificacion !== 'UTF-8') {
      avisos.push('Está guardado en la codificación antigua de Windows, y así se lee.');
    }

    return {
      tipo,
      archivo: 'datos.csv',
      contenido: bytes.subarray(formato.saltar),
      lectura: ordenDeLecturaCsv(formato),
      aviso: avisos.length > 0 ? avisos.join(' ') : null,
    };
  }

  throw new ArchivoNoValido(
    'Ese archivo no es una hoja de datos. Sube tu matriz en Excel (.xlsx), CSV o SPSS (.sav).',
  );
}

module.exports = {
  preparar,
  tipoDe,
  separadorDe,
  decimalDe,
  formatoDeCsv,
  ordenDeLecturaCsv,
  ArchivoNoValido,
};
