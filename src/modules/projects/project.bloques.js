'use strict';

/**
 * Dónde está cada resultado dentro de la consola de R.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * `ver_analisis` devolvía el script y la consola enteros. Sobre un análisis
 * real medido —164 líneas de consola— son 8.634 caracteres, unos 2.500 tokens,
 * cada vez que el asistente quiere comprobar una cifra.
 *
 * Recortar por la cola no sirve, y no es una opinión: en ese mismo análisis, el
 * alfa de Cronbach está en la línea 54 de 164. Quedarse con las últimas 100
 * —más de la mitad de la consola— lo pierde igual, y el alfa es la cifra que
 * sostiene el instrumento entero.
 *
 * POR QUÉ UN CATÁLOGO CERRADO Y NO UNA BÚSQUEDA
 * ---------------------------------------------
 * Porque la búsqueda libre devuelve el bloque equivocado sin avisar. Medido
 * sobre esa consola: «ANOVA» tenía UNA coincidencia y era falsa —la línea del
 * veredicto de `normalidad()`, que nombra tres pruebas de golpe—, mientras la
 * ANOVA de verdad estaba ochenta líneas más abajo. «Pearson» daba tres, y dos
 * eran falsas: ese mismo veredicto y el chi-cuadrado, que R llama «Pearson's
 * Chi-squared test». Y «regresión» o «t test» no encuentran nada, porque R
 * imprime en inglés y con guion.
 *
 * Un índice que se equivoca en silencio es peor que no tener índice: el
 * asistente leería el veredicto de Shapiro creyendo que es la ANOVA.
 *
 * ESTO ES UN REGISTRO
 * -------------------
 * Añadir una prueba es añadir una entrada aquí. Diez de los catorce patrones
 * son el formato de `print()` de R, que no cambia; los otros cuatro los imprime
 * nuestro propio preámbulo de webR, así que son estables por construcción. Ver
 * `acostaresearch-frontend/src/app/core/r/webr.service.ts`.
 *
 * NO SE GUARDA NADA. El índice se recalcula en cada llamada sobre el texto, así
 * que no hay posiciones que se queden rancias y funciona igual con 164 líneas
 * que con novecientas.
 */

/**
 * Las pruebas que sabemos localizar.
 *
 * `inicio` va anclado: `^Alfa de Cronbach:` y no «alfa», porque «alfa» a secas
 * casa también con la tabla de «alfa_si_se_quita» que va dentro del propio
 * bloque. Y en los de R se usa la frase entera del encabezado, que es lo que
 * distingue la correlación de Pearson del chi-cuadrado de Pearson.
 *
 * La tabla cruzada NO está: `table()` imprime la matriz sin encabezado, y
 * cualquier patrón que se inventara para ella marcaría tablas que no lo son.
 * Cae dentro del bloque de frecuencias, que es donde el tesista la pide.
 */
const BLOQUES = [
  {
    clave: 'datos',
    nombre: 'Estructura de los datos',
    inicio: /^'data\.frame':/,
    origen: 'R',
  },
  {
    clave: 'descriptivos',
    nombre: 'Descriptivos',
    inicio: /^\s+n media\s+de minimo maximo/,
    origen: 'preambulo',
  },
  {
    clave: 'frecuencias',
    nombre: 'Frecuencias',
    inicio: /^\s*categoria\s+n porcentaje acumulado/,
    origen: 'preambulo',
  },
  {
    clave: 'alfa',
    nombre: 'Alfa de Cronbach',
    inicio: /^Alfa de Cronbach:/,
    origen: 'preambulo',
  },
  {
    clave: 'normalidad',
    nombre: 'Shapiro-Wilk',
    inicio: /^Shapiro-Wilk sobre/,
    origen: 'preambulo',
  },
  {
    clave: 'pearson',
    nombre: 'Correlación de Pearson',
    inicio: /Pearson's product-moment correlation/,
    origen: 'R',
  },
  {
    clave: 'spearman',
    nombre: 'Correlación de Spearman',
    inicio: /Spearman's rank correlation/,
    origen: 'R',
  },
  {
    clave: 'regresion',
    nombre: 'Regresión lineal',
    inicio: /^Call:/,
    origen: 'R',
  },
  {
    clave: 't-student',
    nombre: 't de Student',
    inicio: /Two Sample t-test/,
    origen: 'R',
  },
  {
    clave: 'mann-whitney',
    nombre: 'U de Mann-Whitney',
    inicio: /^\s*Wilcoxon rank sum test with continuity/,
    origen: 'R',
  },
  {
    clave: 'anova',
    nombre: 'ANOVA',
    inicio: /^\s+Df Sum Sq Mean Sq F value/,
    origen: 'R',
  },
  {
    clave: 'kruskal',
    nombre: 'Kruskal-Wallis',
    inicio: /Kruskal-Wallis rank sum test/,
    origen: 'R',
  },
  {
    clave: 'post-hoc',
    nombre: 'Comparaciones post-hoc',
    inicio: /Pairwise comparisons using/,
    origen: 'R',
  },
  {
    clave: 'chi-cuadrado',
    nombre: 'Chi-cuadrado',
    inicio: /Chi-squared test with/,
    origen: 'R',
  },
];

/** Lo más que se sirve de un rango pedido a mano. Los bloques no se recortan. */
const MAXIMO_LINEAS = 40;

/** Las claves del catálogo, en orden alfabético para poder enseñarlas. */
function claves() {
  return BLOQUES.map((b) => b.clave).sort();
}

/** La definición de una clave, o null si no está en el catálogo. */
function definicionDe(clave) {
  return BLOQUES.find((b) => b.clave === clave) ?? null;
}

/**
 * Hasta dónde llega de verdad un bloque.
 *
 * Se le quitan del final las líneas en blanco y los avisos de R. Sin esto, el
 * bloque de Pearson termina con un «Warning in cor.test.default(… method =
 * "spearman")», que habla de la prueba SIGUIENTE: el aviso se imprime antes que
 * el encabezado del test al que pertenece.
 */
function recortarCola(lineas, desde, hasta) {
  let fin = hasta;

  while (fin > desde) {
    const linea = lineas[fin - 1];
    const vacia = linea.trim() === '';
    const aviso = /^Warning\b/.test(linea);
    // La segunda línea de un aviso va indentada y no dice que lo sea.
    const seguidaDeAviso =
      /^\s{2,}\S/.test(linea) && fin - 1 > desde && /^Warning\b/.test(lineas[fin - 2]);

    if (vacia || aviso || seguidaDeAviso) {
      fin -= 1;
      continue;
    }
    break;
  }

  return fin;
}

/**
 * Los bloques que hay en una consola, en el orden en que aparecen.
 *
 * Cada uno empieza en su marcador y termina justo antes del siguiente, porque
 * declarar un patrón de cierre por prueba serían catorce reglas más y catorce
 * sitios más donde fallar. Lo que sí se hace es limpiar la cola.
 *
 * Las líneas se numeran desde 1, como las cuenta quien las lee.
 */
function detectar(consola) {
  if (typeof consola !== 'string' || consola === '') return [];

  const lineas = consola.split('\n');
  const inicios = [];

  lineas.forEach((linea, i) => {
    const definicion = BLOQUES.find((b) => b.inicio.test(linea));
    if (definicion) inicios.push({ definicion, desde: i + 1 });
  });

  return inicios.map((inicio, i) => {
    const siguiente = i + 1 < inicios.length ? inicios[i + 1].desde - 1 : lineas.length;
    const hasta = recortarCola(lineas, inicio.desde, siguiente);

    return {
      clave: inicio.definicion.clave,
      nombre: inicio.definicion.nombre,
      desde: inicio.desde,
      hasta,
      texto: lineas.slice(inicio.desde - 1, hasta).join('\n'),
    };
  });
}

/**
 * Todas las apariciones de un bloque, no la primera.
 *
 * Un tesista corre los descriptivos sobre los ítems y otra vez sobre los
 * puntajes; en el análisis que se midió salían las dos. Quedarse con una sería
 * decidir por él cuál le interesa, y eso ya es interpretar.
 */
function apariciones(consola, clave) {
  return detectar(consola).filter((b) => b.clave === clave);
}

/**
 * Cuántas líneas de la consola no caen dentro de ningún bloque.
 *
 * Son la carga del archivo, los `head()` y las pruebas que no sabemos nombrar.
 * No se tiran: se dice que están, para que se puedan pedir por rango.
 */
function lineasSueltas(consola) {
  if (typeof consola !== 'string' || consola === '') return 0;

  const total = consola.split('\n').length;
  const cubiertas = detectar(consola).reduce((suma, b) => suma + (b.hasta - b.desde + 1), 0);
  return Math.max(0, total - cubiertas);
}

/**
 * Un tramo de consola pedido a mano, acotado.
 *
 * Se recorta en vez de rechazar: a quien pide ciento veinte líneas le sirve
 * más recibir las cuarenta primeras y saber por dónde seguir que un error.
 */
function tramo(consola, desde, hasta) {
  const lineas = String(consola ?? '').split('\n');
  const total = lineas.length;

  if (!Number.isInteger(desde) || !Number.isInteger(hasta)) return { error: 'no-entero', total };
  if (desde < 1 || hasta < 1 || desde > total) return { error: 'fuera-de-rango', total };
  if (desde > hasta) return { error: 'al-reves', total };

  const tope = Math.min(hasta, total);
  const pedidas = tope - desde + 1;
  const servidas = Math.min(pedidas, MAXIMO_LINEAS);
  const fin = desde + servidas - 1;

  return {
    total,
    desde,
    hasta: fin,
    pedidas,
    recortado: servidas < pedidas,
    siguiente: servidas < pedidas ? fin + 1 : null,
    texto: lineas.slice(desde - 1, fin).join('\n'),
  };
}

module.exports = {
  BLOQUES,
  MAXIMO_LINEAS,
  claves,
  definicionDe,
  detectar,
  apariciones,
  lineasSueltas,
  tramo,
};
