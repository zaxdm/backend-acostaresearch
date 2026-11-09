'use strict';

/**
 * El índice de la consola de `trabajar_en_r`, que guarda las órdenes.
 *
 * E2E de tesis del 8-nov-2026: Claude corrió Shapiro, Mann-Whitney y Wilcoxon
 * imprimiendo solo lo que necesitaba con `cat()`, y `ver_analisis` dijo «No se
 * ha reconocido ningún resultado estadístico en esta consola». En la del 2-nov
 * solo reconocía el alfa, y el segundo alfa se comía la consola hasta el final.
 * Los encabezados de `print()` no estaban; las órdenes sí.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bloques = require('../src/modules/projects/project.bloques');
const { resumenDeAnalisis } = require('../src/modules/projects/project.analisis-presentacion');

/** Como la del 8-nov: preexperimental con dos grupos, todo con `cat()`. */
const CONSOLA_8NOV = [
  '> pre_exp <- d$PRE_TOTAL[d$GRUPO == 1]', //  1
  '> sh <- shapiro.test(pre_exp)', //  2
  '> cat("Shapiro pre exp: W =", round(sh$statistic, 3), " p =", round(sh$p.value, 4), "\\n")', //  3
  'Shapiro pre exp: W = 0.912  p = 0.0412 ', //  4
  '> u <- wilcox.test(POST_TOTAL ~ GRUPO, data = d, exact = FALSE)', //  5
  '> cat("U =", u$statistic, " p =", format.pval(u$p.value), "\\n")', //  6
  'U = 86  p = 2.1e-05 ', //  7
  '> w <- wilcox.test(d$POST_TOTAL[d$GRUPO == 1], d$PRE_TOTAL[d$GRUPO == 1],', //  8
  '+                  paired = TRUE, exact = FALSE)', //  9
  '> w', // 10
  '', // 11
  '\tWilcoxon signed rank test with continuity correction', // 12
  '', // 13
  'data:  d$POST_TOTAL[d$GRUPO == 1] and d$PRE_TOTAL[d$GRUPO == 1]', // 14
  'V = 276, p-value = 1.77e-05', // 15
  'alternative hypothesis: true location shift is not equal to 0', // 16
  '', // 17
  '> png("figura1.png"); plot(d$PRE_TOTAL, d$POST_TOTAL); dev.off()', // 18
  'png ', // 19
  '  2 ', // 20
].join('\n');

/** Un trozo literal de la consola del 2-nov (base simulada, sin datos de nadie). */
const CONSOLA_2NOV = [
  '> alfa_de_cronbach(d[, sprintf("P%02d", 13:27)])', //  1
  'Alfa de Cronbach: 0.947 ', //  2
  'Items: 15  Casos: 120 ', //  3
  '', //  4
  '> cat("\\n== Normalidad ==\\n")', //  5
  '', //  6
  '== Normalidad ==', //  7
  '> for (v in c("V1","UP","FU","V2")) { s <- shapiro.test(d[[v]]); cat(v, ": W =", round(s$statistic, 3), "\\n") }', //  8
  'V1 : W = 0.975 ', //  9
  'V2 : W = 0.988 ', // 10
  '> pares <- list(OG = c("V1","V2"))', // 11
  '> for (k in names(pares)) {', // 12
  '+   ct <- cor.test(d$V1, d$V2, method = "spearman", exact = FALSE)', // 13
  '+   cat(k, " rho =", round(ct$estimate, 3), "\\n")', // 14
  '+ }', // 15
  'OG  rho = 0.556 ', // 16
  '> library(ggplot2)', // 17
  '> tab <- as.data.frame(table(d$N_V1))', // 18
  '> png("figura1-niveles.png", width = 1600, height = 1100, res = 200)', // 19
  '> dev.off()', // 20
  'png ', // 21
  '  2 ', // 22
].join('\n');

const rangos = (consola) => bloques.detectar(consola).map(({ clave, desde, hasta }) => ({ clave, desde, hasta }));

test('la consola del 8-nov: Shapiro, Mann-Whitney y Wilcoxon, por sus órdenes', () => {
  assert.deepEqual(rangos(CONSOLA_8NOV), [
    { clave: 'normalidad', desde: 2, hasta: 4 },
    { clave: 'mann-whitney', desde: 5, hasta: 7 },
    { clave: 'wilcoxon', desde: 8, hasta: 16 },
  ]);
  assert.match(bloques.apariciones(CONSOLA_8NOV, 'mann-whitney')[0].texto, /U = 86/);
  assert.match(bloques.apariciones(CONSOLA_8NOV, 'wilcoxon')[0].texto, /V = 276/);
});

test('la del 2-nov: el alfa ya no se come la consola y salen Shapiro y Spearman', () => {
  assert.deepEqual(rangos(CONSOLA_2NOV), [
    { clave: 'alfa', desde: 1, hasta: 3 },
    { clave: 'normalidad', desde: 5, hasta: 10 },
    { clave: 'spearman', desde: 12, hasta: 16 },
  ]);
});

test('un cálculo que nadie enseña no se lleva la salida de otra orden', () => {
  // `tab <- … table(…)` no imprime; lo siguiente que imprime es `dev.off()`,
  // que no lo enseña: no hay bloque de frecuencias con «png 2» dentro.
  assert.equal(bloques.apariciones(CONSOLA_2NOV, 'frecuencias').length, 0);
});

test('una orden sin nombre que imprime un encabezado se nombra por él', () => {
  const consola = [
    '> m <- cor.test(d$A, d$B)',
    '> print(m)',
    '',
    "\tPearson's product-moment correlation",
    '',
    't = 4.1, df = 58, p-value = 0.0001',
    '> chisq.test(table(d$SEXO, d$NIVEL))',
    '',
    "\tPearson's Chi-squared test",
    '',
    'X-squared = 7.2, df = 2, p-value = 0.027',
  ].join('\n');
  assert.deepEqual(rangos(consola), [
    { clave: 'pearson', desde: 1, hasta: 6 },
    { clave: 'chi-cuadrado', desde: 7, hasta: 11 },
  ]);
});

test('Mann-Whitney exacta y t pareada también se reconocen por su encabezado', () => {
  const consola = [
    'Cargado',
    '\tWilcoxon rank sum exact test',
    'W = 12, p-value = 0.03',
    '\tPaired t-test',
    't = 2.2, df = 9, p-value = 0.05',
  ].join('\n');
  assert.deepEqual(
    bloques.detectar(consola).map((b) => b.clave),
    ['mann-whitney', 't-student'],
  );
});

/**
 * La forma del guion real del 8-nov (literal salvo los datos): cada prueba en
 * una función propia, llamada dentro de un bucle, y las tablas impresas al
 * final con un título. Con la primera versión del arreglo seguía sin salir
 * ninguna de las tres.
 */
const CONSOLA_FUNCIONES = [
  '> sw <- function(x) { t <- shapiro.test(x); c(W = round(unname(t$statistic), 3), p = round(t$p.value, 3)) }', //  1
  '> filas <- list()', //  2
  '> for (v in c("TOTAL","CVM")) for (g in c("Experimental","Control")) {', //  3
  '+   r <- sw(datos[[v]]); filas[[length(filas)+1]] <- data.frame(Variable = v, W = r["W"], p = r["p"])', //  4
  '+ }', //  5
  '> tab_sw <- do.call(rbind, filas); rownames(tab_sw) <- NULL; print(tab_sw)', //  6
  '  Variable     W     p', //  7
  '1    TOTAL 0.967 0.591', //  8
  '> escribir_csv(tab_sw, "tabla-normalidad.csv")', //  9
  'Guardado tabla-normalidad.csv - pidele a Claude el enlace para descargarlo. ', // 10
  '> library(coin)', // 11
  '> mw <- function(y, g) {', // 12
  '+   w <- wilcox.test(y ~ g, exact = FALSE, correct = FALSE)', // 13
  '+   c(U = unname(w$statistic), p = signif(w$p.value, 3))', // 14
  '+ }', // 15
  '> wx <- function(pre, post) {', // 16
  '+   w <- wilcox.test(post, pre, paired = TRUE, exact = FALSE, correct = FALSE)', // 17
  '+   c(V = unname(w$statistic), p = signif(w$p.value, 3))', // 18
  '+ }', // 19
  '> out_mw <- list(); out_wx <- list()', // 20
  '> for (v in c("TOTAL","CVM")) {', // 21
  '+   r <- mw(datos[[paste0("POST_",v)]], datos$GRUPO); out_mw[[length(out_mw)+1]] <- t(r)', // 22
  '+   r <- wx(datos$PRE_TOTAL, datos$POST_TOTAL); out_wx[[length(out_wx)+1]] <- t(r)', // 23
  '+ }', // 24
  '> tab_mw <- do.call(rbind, out_mw)', // 25
  '> tab_wx <- do.call(rbind, out_wx)', // 26
  '> cat("U de Mann-Whitney (Experimental vs Control), N = 47:\\n"); print(tab_mw)', // 27
  'U de Mann-Whitney (Experimental vs Control), N = 47:', // 28
  '      U        p', // 29
  '[1,] 86 4.88e-05', // 30
  '> cat("\\nRangos promedio en el postest:\\n")', // 31
  '', // 32
  'Rangos promedio en el postest:', // 33
  '> cat("\\nWilcoxon pretest vs postest por grupo:\\n"); print(tab_wx)', // 34
  '', // 35
  'Wilcoxon pretest vs postest por grupo:', // 36
  '       V        p', // 37
  '[1,] 300 1.77e-05', // 38
].join('\n');

test('pruebas dentro de funciones propias y tablas impresas con su título', () => {
  assert.deepEqual(rangos(CONSOLA_FUNCIONES), [
    { clave: 'normalidad', desde: 1, hasta: 8 },
    { clave: 'mann-whitney', desde: 21, hasta: 30 },
    { clave: 'wilcoxon', desde: 34, hasta: 38 },
  ]);
  assert.match(bloques.apariciones(CONSOLA_FUNCIONES, 'mann-whitney')[0].texto, /86 4\.88e-05/);
  assert.match(bloques.apariciones(CONSOLA_FUNCIONES, 'wilcoxon')[0].texto, /300 1\.77e-05/);
});

test('un título solo espera a lo que va debajo y se une con su prueba', () => {
  const consola = [
    '> cat("\\n== Normalidad ==\\n")',
    '',
    '== Normalidad ==',
    '> for (v in c("V1","V2")) { s <- shapiro.test(d[[v]]); cat(v, ": W =", round(s$statistic, 3), "\\n") }',
    'V1 : W = 0.975 ',
    '> cat("\\n== Descriptivos ==\\n")',
    '',
    '== Descriptivos ==',
    '> desc <- data.frame(M = mean(d$V1))',
    '> print(desc)',
    '      M',
    '1 44.22',
  ].join('\n');
  assert.deepEqual(rangos(consola), [
    { clave: 'normalidad', desde: 1, hasta: 5 },
    { clave: 'descriptivos', desde: 6, hasta: 12 },
  ]);
});

test('el índice de la consola del 8-nov ya no dice que no reconoce nada', () => {
  const texto = resumenDeAnalisis({
    capitulo: 'analisis-datos-rstudio',
    script: '',
    salida: CONSOLA_8NOV,
    cifras: ['U postest = 86'],
    fecha: null,
  });
  assert.doesNotMatch(texto, /No se ha reconocido/);
  assert.match(texto, /mann-whitney/);
  assert.match(texto, /wilcoxon/);
  assert.doesNotMatch(texto, /no contiene ni un solo número/);
});
