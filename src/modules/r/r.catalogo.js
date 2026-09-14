'use strict';

/**
 * Cómo se lee cada prueba, pegado a la respuesta en el momento en que se corre.
 *
 * Es la columna «comoLee» del catálogo de la página de análisis (ver
 * `features/analisis/comandos.ts` en la web). Allí lo leía el tesista al lado
 * del botón; aquí lo recibe Claude justo detrás del resultado, que es cuando
 * tiene que explicárselo. Dárselo entero al principio sería gastar tokens en
 * pruebas que a lo mejor no se corren nunca.
 *
 * El orden importa: Spearman va antes que Pearson porque las dos se piden con
 * `cor.test`, y solo el `method` las distingue.
 */
const PRUEBAS = [
  {
    clave: 'descriptivos',
    patron: /\bdescriptivos\s*\(/,
    texto:
      'Descriptivos: la media dice por dónde va el grupo y la DE cuánto se dispersa. Una DE muy ' +
      'pequeña en una escala Likert suele significar que todos contestaron parecido.',
  },
  {
    clave: 'frecuencias',
    patron: /\b(?:frecuencias|table)\s*\(/,
    texto:
      'Frecuencias: recuento y porcentaje de cada categoría. Es lo que va tal cual en la tabla ' +
      'de caracterización de la muestra.',
  },
  {
    clave: 'alfa',
    patron: /\balfa_de_cronbach\s*\(/,
    texto:
      'Alfa de Cronbach: por encima de 0,70 se considera aceptable y por encima de 0,80, bueno. Si ' +
      '«alfa_si_se_quita» SUBE en un ítem, ese ítem mide otra cosa: hay que revisarlo o ' +
      'justificarlo.',
  },
  {
    clave: 'normalidad',
    patron: /\b(?:normalidad|shapiro\.test)\s*\(/,
    texto:
      'Shapiro-Wilk: si p ≥ 0,05 los datos NO se apartan de la normal y valen Pearson, t de ' +
      'Student y ANOVA. Si p < 0,05, tocan Spearman, Mann-Whitney y Kruskal-Wallis. Decide el ' +
      'resto del análisis: díselo con esas palabras.',
  },
  {
    clave: 'spearman',
    patron: /\bcor\.test\s*\([^)]*spearman/,
    texto:
      'Spearman: se lee como Pearson pero el coeficiente es rho. El aviso de empates es normal ' +
      'con escalas Likert y no invalida nada.',
  },
  {
    clave: 'pearson',
    patron: /\bcor\.test\s*\(/,
    texto:
      'Correlación: si p < 0,05 hay relación significativa. El coeficiente va de −1 a 1: por ' +
      'debajo de 0,3 es débil, hasta 0,5 moderada y por encima fuerte. El signo da la dirección.',
  },
  {
    clave: 'regresion',
    patron: /\blm\s*\(/,
    texto:
      'Regresión: en summary() busca «Adjusted R-squared», la proporción de la variación explicada ' +
      '(0,25 = 25 %), y en la fila del predictor, «Pr(>|t|)», que es su p-valor.',
  },
  {
    clave: 't',
    patron: /\bt\.test\s*\(/,
    texto:
      't de Student: si p < 0,05 los grupos difieren. Reporta las dos medias junto al p.',
  },
  {
    clave: 'mann-whitney',
    patron: /\bwilcox\.test\s*\(/,
    texto:
      'Mann-Whitney: p < 0,05 significa que los grupos difieren. Compara rangos, no medias: ' +
      'reporta la mediana de cada grupo.',
  },
  {
    clave: 'anova',
    patron: /\b(?:aov|kruskal\.test)\s*\(/,
    texto:
      'ANOVA / Kruskal-Wallis: p < 0,05 dice que AL MENOS un grupo se diferencia, no cuál. Para ' +
      'saber cuáles hace falta el post-hoc (pairwise.wilcox.test o TukeyHSD).',
  },
  {
    clave: 'chi-cuadrado',
    patron: /\b(?:chisq|fisher)\.test\s*\(/,
    texto:
      'Chi-cuadrado: p < 0,05 significa que las dos variables están asociadas. Si R avisa de que la ' +
      'aproximación puede ser incorrecta, alguna casilla tiene menos de cinco casos: usa ' +
      'fisher.test.',
  },
];

/** Cómo se leen las pruebas que aparecen en el código, en orden y sin repetir. */
function comoSeLee(codigo) {
  const texto = String(codigo ?? '');
  const halladas = [];
  let yaHayCorrelacion = false;

  for (const prueba of PRUEBAS) {
    if (!prueba.patron.test(texto)) continue;
    // Un cor.test con spearman no es además un Pearson.
    if (prueba.clave === 'pearson' && yaHayCorrelacion) continue;
    if (prueba.clave === 'spearman') yaHayCorrelacion = true;
    halladas.push(prueba.texto);
  }

  return halladas;
}

module.exports = { comoSeLee, PRUEBAS };
