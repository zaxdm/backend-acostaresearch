'use strict';

/**
 * Cómo se lee cada prueba, pegado a la respuesta en el momento en que se corre.
 *
 * Empezó como la columna «comoLee» del catálogo de la página de análisis (ver
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
    patron: /\bdescriptivos\s*\(|\bdescribe\s*\(/,
    texto:
      'Descriptivos: la media dice por dónde va el grupo y la DE cuánto se dispersa. Una DE muy ' +
      'pequeña en una escala Likert suele significar que todos contestaron parecido. Asimetría y ' +
      'curtosis entre −2 y +2 suelen aceptarse como aproximadamente normales.',
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
    patron: /\balfa_de_cronbach\s*\(|\bpsych::alpha\s*\(|\bomega\s*\(/,
    texto:
      'Confiabilidad: por encima de 0,70 se considera aceptable y por encima de 0,80, buena. Si ' +
      'el alfa SUBE al quitar un ítem, ese ítem mide otra cosa: hay que revisarlo o justificarlo.',
  },
  {
    clave: 'afe',
    patron: /\b(?:factanal|fa|KMO|cortest\.bartlett|fa\.parallel)\s*\(/,
    texto:
      'Análisis factorial exploratorio: KMO ≥ 0,70 y Bartlett con p < 0,05 dicen que los datos se ' +
      'pueden factorizar. Cuántos factores, lo sugiere el análisis paralelo. Cada ítem debería ' +
      'cargar ≥ 0,40 en su factor y no cargar parecido en dos.',
  },
  {
    clave: 'afc',
    patron: /\b(?:cfa|sem)\s*\(/,
    texto:
      'Análisis factorial confirmatorio / SEM: el modelo ajusta bien si CFI y TLI ≥ 0,90 (mejor ' +
      '≥ 0,95), RMSEA ≤ 0,08 y SRMR ≤ 0,08. El chi-cuadrado casi siempre sale significativo con ' +
      'muestras grandes: no se decide por él solo. Las cargas estandarizadas, ≥ 0,50.',
  },
  {
    clave: 'normalidad',
    patron: /\b(?:normalidad|shapiro\.test|lillie\.test|ad\.test)\s*\(/,
    texto:
      'Normalidad: si p ≥ 0,05 los datos NO se apartan de la normal y valen Pearson, t de ' +
      'Student y ANOVA. Si p < 0,05, tocan Spearman, Mann-Whitney y Kruskal-Wallis. Con más de 50 ' +
      'casos se suele reportar Kolmogorov-Smirnov con corrección de Lilliefors en vez de Shapiro.',
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
    clave: 'levene',
    patron: /\bleveneTest\s*\(|\blevene_test\s*\(/,
    texto:
      'Levene: si p ≥ 0,05 las varianzas de los grupos son iguales y vale la t de Student o el ANOVA ' +
      'clásicos. Si p < 0,05, usa la t de Welch (t.test sin var.equal) o el ANOVA de Welch.',
  },
  {
    clave: 't',
    patron: /\bt\.test\s*\(|\bt_test\s*\(/,
    texto:
      't de Student: si p < 0,05 los grupos difieren. Reporta las dos medias junto al p, y el ' +
      'tamaño del efecto (d de Cohen: 0,2 pequeño, 0,5 mediano, 0,8 grande).',
  },
  {
    clave: 'mann-whitney',
    patron: /\bwilcox\.test\s*\(|\bwilcox_test\s*\(/,
    texto:
      'Mann-Whitney: p < 0,05 significa que los grupos difieren. Compara rangos, no medias: ' +
      'reporta la mediana de cada grupo.',
  },
  {
    clave: 'anova',
    patron: /\b(?:aov|kruskal\.test|kruskal_test|anova_test)\s*\(/,
    texto:
      'ANOVA / Kruskal-Wallis: p < 0,05 dice que AL MENOS un grupo se diferencia, no cuál. Para ' +
      'saber cuáles hace falta el post-hoc (TukeyHSD, pairwise.wilcox.test o dunn_test).',
  },
  {
    clave: 'chi-cuadrado',
    patron: /\b(?:chisq|fisher)\.test\s*\(|\bchisq_test\s*\(/,
    texto:
      'Chi-cuadrado: p < 0,05 significa que las dos variables están asociadas. Si R avisa de que la ' +
      'aproximación puede ser incorrecta, alguna casilla tiene menos de cinco casos: usa ' +
      'fisher.test.',
  },
  // ── De otras carreras: salud, economía, biología, multivariante ──
  {
    clave: 'potencia',
    // [\w.]+ y no \w+: los nombres llevan más de un punto (pwr.t.test, pwr.anova.test).
    patron: /\bpwr\.[\w.]+\s*\(/,
    texto:
      'Potencia y tamaño de muestra: lo habitual es potencia ≥ 0,80 con α = 0,05. En ' +
      'pwr.t.test la n es POR GRUPO. El tamaño del efecto hay que justificarlo con antecedentes ' +
      'o con las convenciones de Cohen, no elegirlo para que salga la n que conviene.',
  },
  {
    clave: 'roc',
    patron: /\b(?:roc|auc|coords)\s*\(/,
    texto:
      'Curva ROC: un AUC de 0,5 es azar; ≥ 0,70 aceptable, ≥ 0,80 bueno y ≥ 0,90 excelente. El ' +
      'mejor punto de corte (coords con "best") da la sensibilidad y la especificidad que se reportan.',
  },
  {
    clave: 'riesgo',
    patron: /\b(?:oddsratio|riskratio|epi\.2by2)\s*\(/,
    texto:
      'Odds ratio / riesgo relativo: 1 es no asociación; por encima de 1, factor de riesgo, y por ' +
      'debajo, protector. Es significativo si su intervalo de confianza del 95 % no incluye el 1.',
  },
  {
    clave: 'supervivencia',
    patron: /\b(?:survfit|survdiff|coxph|ggsurvplot|cox\.zph)\s*\(/,
    texto:
      'Supervivencia: Kaplan-Meier da la mediana de supervivencia y log-rank (survdiff) con ' +
      'p < 0,05 dice que las curvas difieren. En Cox, un HR > 1 es más riesgo; el supuesto de ' +
      'riesgos proporcionales se comprueba con cox.zph (p ≥ 0,05).',
  },
  {
    clave: 'metaanalisis',
    patron: /\brma(?:\.\w+)?\s*\(/,
    texto:
      'Metaanálisis: el efecto combinado es significativo si su IC 95 % no cruza el valor nulo. ' +
      'I² mide la heterogeneidad (25 % baja, 50 % moderada, 75 % alta); con heterogeneidad alta, ' +
      'efectos aleatorios y buscar moderadores. El sesgo de publicación se mira con funnel y regtest.',
  },
  {
    clave: 'vif',
    patron: /\bvif\s*\(/,
    texto:
      'VIF: por encima de 5 (10 según el autor que cite) hay multicolinealidad entre los ' +
      'predictores y sus coeficientes no son fiables.',
  },
  {
    clave: 'supuestos-regresion',
    patron: /\b(?:bptest|dwtest|durbinWatsonTest|ncvTest|resettest)\s*\(/,
    texto:
      'Supuestos de la regresión: Breusch-Pagan con p < 0,05 indica heterocedasticidad (usa ' +
      'errores estándar robustos con sandwich y coeftest); Durbin-Watson cercano a 2 indica que ' +
      'no hay autocorrelación de los residuos.',
  },
  {
    clave: 'panel',
    patron: /\bphtest\s*\(|\bplm\s*\(/,
    texto:
      'Datos de panel: la prueba de Hausman (phtest) con p < 0,05 favorece efectos fijos; con ' +
      'p ≥ 0,05, efectos aleatorios.',
  },
  {
    clave: 'series',
    patron: /\b(?:adf\.test|kpss\.test|ur\.df|auto\.arima|Arima|Box\.test)\s*\(/,
    texto:
      'Series de tiempo: en Dickey-Fuller (ADF), p < 0,05 dice que la serie es estacionaria; en ' +
      'KPSS es al revés. Un ARIMA se valida con sus residuos: Ljung-Box con p ≥ 0,05.',
  },
  {
    clave: 'diversidad',
    patron: /\b(?:diversity|specnumber|adonis2|metaMDS)\s*\(/,
    texto:
      'Diversidad y comunidades: Shannon suele ir de 1,5 a 3,5 (más alto, más diverso) y Simpson ' +
      'de 0 a 1. En PERMANOVA (adonis2), p < 0,05 dice que la composición difiere entre grupos; ' +
      'en un NMDS, un stress < 0,20 es aceptable.',
  },
  {
    clave: 'componentes',
    patron: /\b(?:PCA|MCA|CA|prcomp|princomp)\s*\(/,
    texto:
      'Componentes / correspondencias: se retienen las dimensiones con autovalor > 1 o las que ' +
      'acumulan en torno al 70 % de la varianza. Las variables con más contribución (cos2) son ' +
      'las que dan nombre a cada dimensión.',
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
