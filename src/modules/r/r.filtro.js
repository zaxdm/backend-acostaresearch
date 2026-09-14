'use strict';

/**
 * La segunda de las tres capas: lo que no se ejecuta aunque Claude lo mande.
 *
 * LO QUE ESTO NO ES
 * -----------------
 * No es la protección del servidor. R deja construir órdenes a partir de texto
 * y ninguna lista de palabras aguanta a quien se empeñe; además, al conector se
 * le puede llamar sin pasar por Claude. Lo que protege el servidor es la jaula
 * de systemd (infra/r/acostaresearch-r@.service): sin red, sin secretos a la
 * vista, y con tope de memoria, procesos y tiempo.
 *
 * LO QUE SÍ ES
 * ------------
 * Un freno para lo evidente y un rastro. El tesista curioso que le pide a Claude
 * «lee el .env» se queda aquí, con una explicación, y el intento queda anotado
 * en el uso de su licencia, donde el panel de vigilancia lo ve.
 *
 * Y NO PUEDE ESTORBAR A UNA TESIS
 * -------------------------------
 * Un filtro que rechaza análisis normales enseña a Claude a sortearlo, y eso es
 * peor que no tenerlo. Por eso las rutas se buscan DENTRO de los textos entre
 * comillas —una fórmula con `Puntaje total` ~ edad no es una ruta— y buscar un
 * objeto por su nombre, `get(paste0("puntaje_", i))`, solo se para si los textos
 * del código nombran algo peligroso.
 */

/** Los paquetes que hay instalados en el servidor. Cualquier otro, no. */
const PAQUETES_PERMITIDOS = new Set([
  'base',
  'stats',
  'utils',
  'graphics',
  'grDevices',
  'methods',
  'datasets',
  'grid',
  'splines',
  'stats4',
  // Los «recomendados», que vienen con R.
  'MASS',
  'boot',
  'class',
  'cluster',
  'foreign',
  'KernSmooth',
  'lattice',
  'Matrix',
  'mgcv',
  'nlme',
  'nnet',
  'rpart',
  'spatial',
  'survival',
  // Para leer el Excel y el SPSS que sube el tesista, y para devolverle tablas.
  'readxl',
  'haven',
  'writexl',
  'openxlsx',
  'flextable',
  'officer',
  // Manejo de datos y gráficos.
  'tidyverse',
  'dplyr',
  'tidyr',
  'readr',
  'forcats',
  'stringr',
  'purrr',
  'tibble',
  'lubridate',
  'magrittr',
  'glue',
  'scales',
  'ggplot2',
  'ggpubr',
  'gridExtra',
  'cowplot',
  'ggrepel',
  'corrplot',
  // Lo psicométrico y lo inferencial de una tesis.
  'psych',
  'GPArotation',
  'psy',
  'lavaan',
  'semTools',
  'car',
  'carData',
  'rstatix',
  'nortest',
  'effectsize',
  'performance',
  'parameters',
  'insight',
  'datawizard',
  'bayestestR',
  'broom',
  'emmeans',
  'lme4',
  // Tablas y gráficos de publicación, y datos incompletos.
  'rio',
  'knitr',
  'patchwork',
  'skimr',
  'kableExtra',
  'sjPlot',
  'sjmisc',
  'sjstats',
  'ggeffects',
  'GGally',
  'ggthemes',
  'viridis',
  'viridisLite',
  'ggalluvial',
  'dendextend',
  'mice',
  'Hmisc',
  // Inferencia, potencia y modelos que no son lineales simples.
  'pwr',
  'coin',
  'multcomp',
  'lmerTest',
  'ordinal',
  'pscl',
  'polycor',
  'vcd',
  // Psicometría.
  'semPlot',
  'eRm',
  'qgraph',
  // Ciencias de la salud.
  'epitools',
  'epiR',
  'pROC',
  'survminer',
  'metafor',
  'metadat',
  // Encuestas con muestreo complejo.
  'survey',
  // Economía: panel, series de tiempo y supuestos econométricos.
  'plm',
  'AER',
  'lmtest',
  'sandwich',
  'forecast',
  'tseries',
  'urca',
  'zoo',
  'xts',
  // Biología, ecología y ambiente.
  'vegan',
  'ade4',
  // Multivariante y aprendizaje automático.
  'FactoMineR',
  'factoextra',
  'randomForest',
  'glmnet',
  'e1071',
  'caret',
  // Texto: respuestas abiertas, entrevistas transcritas.
  'tidytext',
  'tm',
  'NLP',
  'SnowballC',
  'wordcloud',
]);

/** Reglas sobre el código, ya sin comentarios. */
const REGLAS = [
  {
    regla: 'sistema',
    motivo: 'ejecuta órdenes del sistema operativo',
    patron: /\b(?:system2?|shell|shell\.exec|Sys\.which)\s*\(/,
  },
  {
    regla: 'entorno',
    motivo: 'lee o cambia la configuración del sistema',
    patron: /\bSys\.(?:getenv|setenv|unsetenv|umask|chmod|readlink|setFileTime|setlocale|junction)\b/,
  },
  {
    regla: 'red',
    motivo: 'abre conexiones de red o tuberías hacia otros programas',
    patron:
      /\b(?:url|pipe|fifo|socketConnection|socketAccept|serverSocket|make\.socket|read\.socket|write\.socket|download\.file|curlGetHeaders|nsl|browseURL)\s*\(/,
  },
  {
    regla: 'paquetes',
    motivo: 'instala o quita paquetes',
    patron: /\b(?:install|remove|update)\.packages\b|\.libPaths\b/,
  },
  {
    regla: 'codigo-nativo',
    motivo: 'llama a código compilado o a las tripas de R',
    patron:
      /\.(?:Internal|Primitive|Call|External2?|C|Fortran)\s*\(|\bdyn\.(?:load|unload)\b|\blibrary\.dynam\b|\bgetNativeSymbolInfo\b/,
  },
  {
    regla: 'ofuscacion',
    motivo: 'construye el código a partir de texto, que es como se esconde lo que hace',
    patron: /\b(?:eval|evalq)\s*\(\s*(?:parse|str2lang|str2expression)\s*\(|\bstr2(?:lang|expression)\s*\(|\brawToChar\s*\(/,
  },
  {
    regla: 'manipulacion',
    motivo: 'altera el propio R o sus límites',
    patron:
      /\b(?:assignInNamespace|unlockBinding|lockBinding|setTimeLimit|setSessionTimeLimit|reg\.finalizer)\s*\(|\b(?:q|quit)\s*\(/,
  },
  {
    regla: 'archivos',
    motivo: 'sale de la carpeta de trabajo del tesista',
    patron: /\b(?:setwd|file\.symlink|file\.link)\s*\(/,
  },
];

/** Un texto entre comillas que apunta fuera de la carpeta de trabajo. */
const RUTA_DE_FUERA = /^\s*(?:\/[A-Za-z._]|~(?:[/\\]|$)|[A-Za-z]:[/\\]|\\\\)|(?:^|[/\\])\.\.(?:[/\\]|$)/;

/** Funciones que buscan otra función por su nombre escrito como texto. */
const BUSQUEDA_POR_NOMBRE = /\b(?:get0?|mget|match\.fun|getFromNamespace|do\.call|exists)\s*\(/;

/** Lo que no puede salir al juntar los textos de un código que busca por nombre. */
const NOMBRES_PELIGROSOS = /system|shell|getenv|setenv|internal|\.call|dyn\.load|socket|pipe|download|readlink|quit/i;

/**
 * Separa el código de sus textos.
 *
 * Devuelve el código sin comentarios —para no rechazar un «# ver /etc/…»
 * escrito como nota— y la lista de lo que hay entre comillas simples o dobles.
 * Las comillas invertidas son nombres, no textos: `Puntaje total` no se mira
 * como ruta.
 */
function analizar(codigo) {
  let limpio = '';
  const textos = [];
  let comilla = null;
  let actual = '';
  let enComentario = false;

  for (let i = 0; i < codigo.length; i += 1) {
    const c = codigo[i];

    if (enComentario) {
      if (c === '\n') {
        enComentario = false;
        limpio += c;
      }
      continue;
    }

    if (comilla) {
      limpio += c;
      if (c === '\\' && i + 1 < codigo.length) {
        limpio += codigo[i + 1];
        actual += codigo[i + 1];
        i += 1;
      } else if (c === comilla) {
        if (comilla !== '`') textos.push(actual);
        comilla = null;
        actual = '';
      } else {
        actual += c;
      }
      continue;
    }

    if (c === '#') {
      enComentario = true;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') comilla = c;
    limpio += c;
  }

  return { limpio, textos };
}

/** El primer paquete no permitido que carga o al que llama con `::`, o null. */
function paqueteNoPermitido(codigo) {
  const cargas =
    /\b(?:library|require|requireNamespace|loadNamespace|attachNamespace)\s*\(\s*(?:package\s*=\s*)?["'`]?([A-Za-z][A-Za-z0-9._]*)/g;
  const prefijos = /\b([A-Za-z][A-Za-z0-9.]*):::?/g;

  for (const patron of [cargas, prefijos]) {
    for (const [, paquete] of codigo.matchAll(patron)) {
      if (!PAQUETES_PERMITIDOS.has(paquete)) return paquete;
    }
  }
  return null;
}

/** null si el código puede ejecutarse; si no, qué regla lo para y por qué. */
function revisar(codigo) {
  const { limpio, textos } = analizar(String(codigo ?? ''));

  for (const { regla, motivo, patron } of REGLAS) {
    const hallado = patron.exec(limpio);
    if (hallado) return { regla, motivo, fragmento: hallado[0].trim().slice(0, 60) };
  }

  const ruta = textos.find((t) => RUTA_DE_FUERA.test(t));
  if (ruta !== undefined) {
    return {
      regla: 'archivos',
      motivo: 'sale de la carpeta de trabajo del tesista',
      fragmento: ruta.slice(0, 60),
    };
  }

  // `get(paste0("sys", "tem"))`: cada trozo es inocente, juntos no.
  if (BUSQUEDA_POR_NOMBRE.test(limpio)) {
    const juntos = textos.join('');
    const nombre = NOMBRES_PELIGROSOS.exec(juntos);
    if (nombre) {
      return {
        regla: 'ofuscacion',
        motivo: 'busca por su nombre una función del sistema',
        fragmento: nombre[0],
      };
    }
  }

  const paquete = paqueteNoPermitido(limpio);
  if (paquete) {
    return {
      regla: 'paquetes',
      motivo: `usa el paquete «${paquete}», que no está instalado en este R`,
      fragmento: paquete,
    };
  }

  return null;
}

module.exports = { revisar, analizar, PAQUETES_PERMITIDOS };
