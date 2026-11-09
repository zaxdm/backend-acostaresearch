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
 * Añadir una prueba es añadir una entrada aquí. Once de los quince patrones
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
    // El nuestro y, debajo, el de `print(shapiro.test(x))`.
    inicio: /^Shapiro-Wilk sobre|Shapiro-Wilk normality test/,
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
    inicio: /(Two Sample|Paired|One Sample) t-test/,
    origen: 'R',
  },
  {
    clave: 'mann-whitney',
    nombre: 'U de Mann-Whitney',
    // Con corrección, sin ella y la exacta (muestras pequeñas sin empates).
    inicio: /^\s*Wilcoxon rank sum (exact )?test/,
    origen: 'R',
  },
  {
    clave: 'wilcoxon',
    nombre: 'Wilcoxon de rangos con signo',
    inicio: /^\s*Wilcoxon signed rank (exact )?test/,
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
    // «with Yates' continuity correction» solo sale en las tablas 2×2; en las
    // demás el encabezado es «Pearson's Chi-squared test» a secas. Y Fisher,
    // que es lo que se usa cuando el chi-cuadrado no se puede.
    inicio: /Chi-squared test|Fisher's Exact Test/,
    origen: 'R',
  },
];

/**
 * Las órdenes de R que hacen cada prueba.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * Los encabezados de arriba son los de `print()`. Pero cuando Claude corre el
 * análisis con `trabajar_en_r`, casi nunca imprime la prueba entera: escribe
 * `s <- shapiro.test(x); cat("W =", s$statistic, …)`, y en la consola no queda
 * ningún encabezado. En la tesis de prueba del 8-nov-2026, con Shapiro,
 * Mann-Whitney y Wilcoxon, el índice no reconoció nada; en la del 2-nov solo
 * el alfa.
 *
 * Esa consola sí guarda cada orden, con su «> » delante. La orden es tan
 * literal como el encabezado: si dice `wilcox.test(…, paired = TRUE)`, lo que
 * sale debajo es un Wilcoxon. Sigue siendo un catálogo cerrado de funciones,
 * no una búsqueda de palabras.
 */
const ORDENES = [
  { clave: 'alfa', patron: /\b(?:alfa_de_cronbach|cronbach\.alpha|alpha)\s*\(/ },
  { clave: 'normalidad', patron: /\b(?:normalidad|shapiro\.test|lillie\.test|ad\.test|ks\.test)\s*\(/ },
  { clave: 'descriptivos', patron: /\b(?:descriptivos|describe)\s*\(/ },
  { clave: 'frecuencias', patron: /\b(?:frecuencias|table|prop\.table)\s*\(/ },
  { clave: 'correlacion', patron: /\bcor\.test\s*\(/ },
  { clave: 't-student', patron: /\bt\.test\s*\(/ },
  { clave: 'wilcox', patron: /\bwilcox\.test\s*\(/ },
  { clave: 'anova', patron: /\b(?:aov|anova|Anova)\s*\(/ },
  { clave: 'kruskal', patron: /\bkruskal\.test\s*\(/ },
  { clave: 'post-hoc', patron: /\b(?:pairwise\.\w+|TukeyHSD|dunn\.test|dunnTest)\s*\(/ },
  { clave: 'chi-cuadrado', patron: /\b(?:chisq\.test|fisher\.test)\s*\(/ },
  { clave: 'regresion', patron: /\b(?:lm|glm)\s*\(/ },
];

/**
 * La prueba que hace una orden, o null.
 *
 * Si nombra varias, manda la primera que aparece en el texto. `cor.test` y
 * `wilcox.test` se separan por sus argumentos: el método y si es pareada.
 */
function claveDeOrden(orden, propias = new Map()) {
  let primera = null;
  for (const o of ORDENES) {
    const m = o.patron.exec(orden);
    if (m && (!primera || m.index < primera.index)) primera = { clave: o.clave, index: m.index };
  }
  // Las funciones que definió Claude con una prueba dentro: `mw(y, g)`.
  for (const [nombre, clave] of propias) {
    const m = new RegExp(`(?:^|[^\\w.$])${nombre.replace(/\./g, '\\.')}\\s*\\(`).exec(orden);
    if (m && (!primera || m.index < primera.index)) primera = { clave, index: m.index };
  }
  if (!primera) return null;
  if (primera.clave === 'correlacion') {
    if (/method\s*=\s*["']spearman/.test(orden)) return 'spearman';
    if (/method\s*=\s*["']kendall/.test(orden)) return null;
    return 'pearson';
  }
  if (primera.clave === 'wilcox') {
    return /paired\s*=\s*(?:TRUE|T)\b/.test(orden) ? 'wilcoxon' : 'mann-whitney';
  }
  return primera.clave;
}

/**
 * El nombre de una función que define Claude, si dentro hace una prueba:
 * `mw <- function(y, g) { … wilcox.test(…) … }`. Sus llamadas cuentan como esa
 * prueba (E2E del 8-nov: `sw`, `mw` y `wx`, llamadas dentro de un bucle).
 */
function funcionDefinida(orden) {
  const m = /^\s*([A-Za-z.][\w.]*)\s*(?:<-|=)\s*function\s*\(/.exec(orden);
  return m ? m[1] : null;
}

/**
 * Los títulos con que Claude presenta una salida: `cat("U de Mann-Whitney
 * (Experimental vs Control):\n"); print(tab_mw)`. Solo se mira el texto
 * entre comillas del `cat()` con que EMPIEZA la orden, nunca la salida: ahí
 * es donde «ANOVA» casaba con el veredicto de normalidad.
 *
 * El orden importa: el chi-cuadrado «de Pearson» antes que Pearson, y
 * Mann-Whitney (que R llama «Wilcoxon rank sum») antes que Wilcoxon.
 */
const TITULOS = [
  { clave: 'chi-cuadrado', patron: /chi.?cuadrad|chi.?squared|\bfisher\b/i },
  { clave: 'mann-whitney', patron: /mann.?whitney|\bU de\b/i },
  { clave: 'wilcoxon', patron: /wilcoxon/i },
  { clave: 'normalidad', patron: /normalidad|shapiro|kolmogorov/i },
  { clave: 'spearman', patron: /spearman/i },
  { clave: 'pearson', patron: /pearson/i },
  { clave: 'kruskal', patron: /kruskal/i },
  { clave: 'post-hoc', patron: /post.?hoc|\bdunn\b|\btukey\b/i },
  { clave: 'anova', patron: /\banova\b/i },
  { clave: 't-student', patron: /t de student|\bt-test\b|\bwelch\b/i },
  { clave: 'regresion', patron: /regresi[oó]n/i },
  { clave: 'alfa', patron: /cronbach|\balfa\b/i },
  { clave: 'descriptivos', patron: /descriptiv/i },
  { clave: 'frecuencias', patron: /frecuencia/i },
];

/** La prueba que nombra el título de una orden que empieza con `cat("…")`. */
function claveDeTitulo(orden) {
  const m = /^\s*cat\s*\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/.exec(orden);
  if (!m) return null;
  return TITULOS.find((t) => t.patron.test(m[2]))?.clave ?? null;
}

/** Una orden que solo escribe un título: `cat("\n== Normalidad ==\n")`. */
const SOLO_TITULO = /^\s*cat\s*\(\s*(["'])(?:\\.|(?!\1)[^\\])*\1\s*\)\s*;?\s*$/;

/**
 * Una orden que enseña lo que otra calculó: `print(s)`, `cat(… s$p.value …)`,
 * `summary(modelo)` o el nombre del objeto a secas. Puede ir detrás de una
 * asignación, en la misma línea: `tab <- do.call(rbind, filas); print(tab)`.
 */
const ORDEN_QUE_MUESTRA = /\b(?:print|cat|summary|show|kable)\s*\(|^\s*[\w.$]+\s*$/;

/** Hasta cuántas órdenes sin salida se espera a la que enseña el resultado. */
const ESPERA_MAXIMA = 3;

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
  if (lineas.some((l) => /^> /.test(l))) return detectarPorOrdenes(lineas);

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

/** Un bloque con su texto, recortada la cola. */
function bloque(lineas, clave, desde, hasta) {
  const fin = recortarCola(lineas, desde, hasta);
  return {
    clave,
    nombre: definicionDe(clave).nombre,
    desde,
    hasta: fin,
    texto: lineas.slice(desde - 1, fin).join('\n'),
  };
}

/** Si un tramo trae algo impreso, además de la propia orden. */
function traeSalida(lineas, desde, hasta, finOrden) {
  return lineas.slice(Math.max(desde, finOrden + 1) - 1, hasta).some((l) => l.trim() !== '');
}

/**
 * Los bloques de una consola que guarda las órdenes (la de `trabajar_en_r`, o
 * un RStudio pegado entero).
 *
 * Cada orden va de su «> » hasta antes de la siguiente. Se nombra por su
 * función (de R o una que definió Claude con una prueba dentro), si no por el
 * título de su `cat("…")` y, si no, por el encabezado que imprimió. Si imprimió
 * varios (un bucle con varias pruebas), se parte por ellos.
 *
 * Una orden que solo calcula (`s <- shapiro.test(x)`) no enseña nada: el
 * bloque sigue hasta la orden que lo enseña (`cat(…)`, `print(s)`), si llega
 * enseguida. Si lo siguiente es otra cosa, no se le cuelga una salida ajena.
 */
function detectarPorOrdenes(lineas) {
  // 1. Las órdenes: su «> », sus «+ » y lo que imprimieron.
  const ordenes = [];
  lineas.forEach((linea, i) => {
    if (/^> /.test(linea) || linea === '>') {
      ordenes.push({ desde: i + 1, finOrden: i + 1, finSalida: i + 1 });
    } else if (ordenes.length > 0) {
      const ultima = ordenes[ordenes.length - 1];
      if (/^\+ /.test(linea) && ultima.finSalida === ultima.finOrden) ultima.finOrden = i + 1;
      ultima.finSalida = i + 1;
    }
  });

  // 2. Cada orden, con su prueba.
  const hallados = [];
  const propias = new Map();
  let pendiente = null;
  // Queda a la espera de la orden que lo enseñe; si es la misma prueba, desde
  // donde empezó a calcularse.
  const esperar = (clave, desde) => {
    pendiente =
      pendiente && pendiente.clave === clave
        ? { ...pendiente, esperando: 0 }
        : { clave, desde, esperando: 0 };
  };

  for (const orden of ordenes) {
    const texto = lineas
      .slice(orden.desde - 1, orden.finOrden)
      .map((l) => l.replace(/^[>+] ?/, ''))
      .join('\n');
    const deLaOrden = claveDeOrden(texto, propias);
    const nombre = funcionDefinida(texto);
    if (nombre && deLaOrden) propias.set(nombre, deLaOrden);
    const titulo = deLaOrden ? null : claveDeTitulo(texto);
    const clave = deLaOrden ?? titulo;
    const encabezados = [];
    for (let n = orden.finOrden + 1; n <= orden.finSalida; n += 1) {
      const definicion = BLOQUES.find((b) => b.inicio.test(lineas[n - 1]));
      if (definicion) encabezados.push({ clave: definicion.clave, linea: n });
    }

    if (
      !traeSalida(lineas, orden.desde, orden.finSalida, orden.finOrden) ||
      (titulo && SOLO_TITULO.test(texto) && encabezados.length === 0)
    ) {
      // Calcula sin enseñar, o solo pone el título: lo que importa viene después.
      if (clave) esperar(clave, orden.desde);
      else if (pendiente && ++pendiente.esperando > ESPERA_MAXIMA) pendiente = null;
      continue;
    }

    if (!clave && encabezados.length === 0) {
      if (pendiente && ORDEN_QUE_MUESTRA.test(texto)) {
        hallados.push(bloque(lineas, pendiente.clave, pendiente.desde, orden.finSalida));
      }
      pendiente = null;
      continue;
    }

    // La orden se reconoce, o imprimió encabezados, o las dos cosas.
    const propia = clave ?? encabezados[0].clave;
    let inicio = {
      clave: propia,
      desde: pendiente && pendiente.clave === propia ? pendiente.desde : orden.desde,
    };
    pendiente = null;

    const cortes = encabezados.filter((e, j) => j > 0 || e.clave !== propia);
    for (const corte of cortes) {
      if (traeSalida(lineas, inicio.desde, corte.linea - 1, orden.finOrden)) {
        hallados.push(bloque(lineas, inicio.clave, inicio.desde, corte.linea - 1));
      }
      inicio = { clave: corte.clave, desde: corte.linea };
    }
    hallados.push(bloque(lineas, inicio.clave, inicio.desde, orden.finSalida));
  }

  // 3. Dos bloques de la misma prueba, sin nada entre ellos, son uno.
  const unidos = [];
  for (const b of hallados) {
    const anterior = unidos[unidos.length - 1];
    const entre = anterior ? lineas.slice(anterior.hasta, b.desde - 1) : null;
    if (anterior && anterior.clave === b.clave && entre.every((l) => l.trim() === '')) {
      unidos[unidos.length - 1] = bloque(lineas, b.clave, anterior.desde, b.hasta);
    } else {
      unidos.push(b);
    }
  }
  return unidos;
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
