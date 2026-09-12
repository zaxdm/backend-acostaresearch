'use strict';

/**
 * El índice de la consola de R, sobre una consola de verdad.
 *
 * EL FIXTURE ES REAL. Son las 164 líneas que devolvió webR al correr una sesión
 * completa de Capítulo IV contra `datos-tesis-ejemplo.csv`, la matriz de
 * ejemplo del propio proyecto: descriptivos, frecuencias, tabla cruzada, alfa,
 * puntajes, Shapiro, Pearson, Spearman, regresión, t de Student, Mann-Whitney,
 * ANOVA, Kruskal-Wallis, post-hoc y chi-cuadrado. No hay datos de ningún
 * tesista aquí dentro.
 *
 * Se prueba contra esto y no contra un ejemplo inventado porque los dos fallos
 * que este módulo existe para evitar solo se ven con salida real: que «ANOVA»
 * case con el veredicto de `normalidad()` en vez de con la ANOVA, y que el
 * bloque de Pearson se quede con un aviso que habla de Spearman.
 *
 * Los números de línea que se afirman aquí describen ESTE fixture. La lógica no
 * conoce ninguna posición: las calcula sobre el texto que le llega.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bloques = require('../src/modules/projects/project.bloques');

/** La consola real, tal como la guardó el conector. */
const CONSOLA = `Cargado «datos-tesis-ejemplo.csv» como datos.csv
[1] 60 12
  id sexo edad ciclo cd1 cd2 cd3 cd4 emp1 emp2 emp3 emp4
1  1    F   22     X   3   3   3   4    2    2    2    2
2  2    F   23     X   3   2   2   1    2    2    3    2
3  3    F   23     X   3   2   3   3    3    4    3    4
4  4    F   23     X   3   4   3   3    3    3    2    3
5  5    F   24     X   2   1   2   2    1    2    2    1
6  6    F   27    IX   4   4   4   3    4    4    4    4
  id sexo edad ciclo cd1 cd2 cd3 cd4 emp1 emp2 emp3 emp4
1  1    F   22     X   3   3   3   4    2    2    2    2
2  2    F   23     X   3   2   2   1    2    2    3    2
3  3    F   23     X   3   2   3   3    3    4    3    4
4  4    F   23     X   3   4   3   3    3    3    2    3
5  5    F   24     X   2   1   2   2    1    2    2    1
6  6    F   27    IX   4   4   4   3    4    4    4    4
[1] 60 12
 [1] "id"    "sexo"  "edad"  "ciclo" "cd1"   "cd2"   "cd3"   "cd4"   "emp1" 
[10] "emp2"  "emp3"  "emp4" 
   id  sexo  edad ciclo   cd1   cd2   cd3   cd4  emp1  emp2  emp3  emp4 
    0     0     0     0     0     0     0     0     0     0     0     0 
'data.frame':\t60 obs. of  12 variables:
 $ id   : int  1 2 3 4 5 6 7 8 9 10 ...
 $ sexo : chr  "F" "F" "F" "F" ...
 $ edad : int  22 23 23 23 24 27 26 22 27 22 ...
 $ ciclo: chr  "X" "X" "X" "X" ...
 $ cd1  : int  3 3 3 3 2 4 4 2 3 3 ...
 $ cd2  : int  3 2 2 4 1 4 3 1 3 3 ...
 $ cd3  : int  3 2 3 3 2 4 2 1 2 4 ...
 $ cd4  : int  4 1 3 3 2 3 4 1 2 3 ...
 $ emp1 : int  2 2 3 3 1 4 4 2 3 4 ...
 $ emp2 : int  2 2 4 3 2 4 4 2 2 4 ...
 $ emp3 : int  2 3 3 2 2 4 4 1 2 4 ...
 $ emp4 : int  2 2 4 3 1 4 4 2 2 3 ...
      n media    de minimo maximo
id   60 30.50 17.46      1     60
edad 60 23.87  1.85     21     27
cd1  60  3.03  1.07      1      5
cd2  60  2.90  1.12      1      5
cd3  60  2.95  1.08      1      5
cd4  60  2.93  1.12      1      5
emp1 60  2.87  0.96      1      5
emp2 60  2.82  1.07      1      5
emp3 60  2.77  1.09      1      5
emp4 60  2.68  1.00      1      5
 categoria  n porcentaje acumulado
         F 37       61.7      61.7
         M 23       38.3     100.0
Total: 60 casos
   
    IX  X
  F 22 15
  M  7 16
Alfa de Cronbach: 0.886 
Items: 4  Casos: 60 

Si el alfa SUBE al quitar un item, ese item mide otra cosa:
    r_item_resto alfa_si_se_quita
cd1        0.763            0.850
cd2        0.759            0.851
cd3        0.692            0.876
cd4        0.793            0.838
     n media   de minimo maximo
CD  60  2.95 0.95   1.25      5
EMP 60  2.78 0.90   1.00      5
Shapiro-Wilk sobre la variable 
  W = 0.9701    p = 0.1478    n = 60 

p >= 0.05: los datos NO se apartan de la normal.
Puedes usar pruebas parametricas: Pearson, t de Student, ANOVA.

\tPearson's product-moment correlation

data:  datos$CD and datos$EMP
t = 4.5297, df = 58, p-value = 2.996e-05
alternative hypothesis: true correlation is not equal to 0
95 percent confidence interval:
 0.2956450 0.6772129
sample estimates:
      cor 
0.5111936 

Warning in cor.test.default(datos$CD, datos$EMP, method = "spearman") :
  Cannot compute exact p-value with ties

\tSpearman's rank correlation rho

data:  datos$CD and datos$EMP
S = 19032, p-value = 0.0001448
alternative hypothesis: true rho is not equal to 0
sample estimates:
      rho 
0.4711889 


Call:
lm(formula = EMP ~ CD, data = datos)

Residuals:
     Min       1Q   Median       3Q      Max 
-1.52720 -0.60016 -0.05205  0.67843  1.82295 

Coefficients:
            Estimate Std. Error t value Pr(>|t|)    
(Intercept)   1.3482     0.3325   4.055 0.000151 ***
CD            0.4858     0.1072   4.530    3e-05 ***
---
Signif. codes:  0 ‘***’ 0.001 ‘**’ 0.01 ‘*’ 0.05 ‘.’ 0.1 ‘ ’ 1

Residual standard error: 0.7803 on 58 degrees of freedom
Multiple R-squared:  0.2613,\tAdjusted R-squared:  0.2486 
F-statistic: 20.52 on 1 and 58 DF,  p-value: 2.996e-05


\tWelch Two Sample t-test

data:  datos$CD by datos$sexo
t = -1.5054, df = 40.029, p-value = 0.1401
alternative hypothesis: true difference in means between group F and group M is not equal to 0
95 percent confidence interval:
 -0.9173321  0.1341359
sample estimates:
mean in group F mean in group M 
       2.804054        3.195652 

Warning in wilcox.test.default(x = DATA[[1L]], y = DATA[[2L]], ...) :
  cannot compute exact p-value with ties

\tWilcoxon rank sum test with continuity correction

data:  datos$CD by datos$sexo
W = 322, p-value = 0.1159
alternative hypothesis: true location shift is not equal to 0

   F    M 
2.75 3.25 
                   Df Sum Sq Mean Sq F value Pr(>F)
factor(datos$sexo)  1   2.18  2.1750   2.485   0.12
Residuals          58  50.76  0.8752               

\tKruskal-Wallis rank sum test

data:  datos$CD by factor(datos$sexo)
Kruskal-Wallis chi-squared = 2.4956, df = 1, p-value = 0.1142

Warning in wilcox.test.default(xi, xj, paired = paired, ...) :
  cannot compute exact p-value with ties

\tPairwise comparisons using Wilcoxon rank sum test with continuity correction 

data:  datos$CD and datos$sexo 

  F   
M 0.12

P value adjustment method: holm 

\tPearson's Chi-squared test with Yates' continuity correction

data:  table(datos$sexo, datos$ciclo)
X-squared = 3.693, df = 1, p-value = 0.05464

png 
  2`;

/** Lo que hay en ESE fixture, comprobado a mano línea por línea. */
const ESPERADO = [
  { clave: 'datos', desde: 22, hasta: 34 },
  { clave: 'descriptivos', desde: 35, hasta: 45 },
  { clave: 'frecuencias', desde: 46, hasta: 53 },
  { clave: 'alfa', desde: 54, hasta: 62 },
  { clave: 'descriptivos', desde: 63, hasta: 65 },
  { clave: 'normalidad', desde: 66, hasta: 70 },
  { clave: 'pearson', desde: 72, hasta: 81 },
  { clave: 'spearman', desde: 86, hasta: 93 },
  { clave: 'regresion', desde: 96, hasta: 112 },
  { clave: 't-student', desde: 115, hasta: 124 },
  { clave: 'mann-whitney', desde: 129, hasta: 136 },
  { clave: 'anova', desde: 137, hasta: 139 },
  { clave: 'kruskal', desde: 141, hasta: 144 },
  { clave: 'post-hoc', desde: 149, hasta: 156 },
  // Llega hasta el final porque detrás va el «png / 2» de guardar el gráfico, y
  // eso no tiene marcador: se queda con el bloque anterior en vez de perderse.
  { clave: 'chi-cuadrado', desde: 158, hasta: 164 },
];

test('el fixture es la consola real de 164 líneas', () => {
  assert.equal(CONSOLA.split('\n').length, 164);
  assert.equal(CONSOLA.length, 5193);
});

test('detecta los 15 bloques del análisis real, con sus rangos', () => {
  const hallados = bloques.detectar(CONSOLA);

  assert.equal(hallados.length, 15);
  assert.deepEqual(
    hallados.map((b) => ({ clave: b.clave, desde: b.desde, hasta: b.hasta })),
    ESPERADO,
  );
});

test('cero falsos positivos: cada bloque empieza donde de verdad empieza', () => {
  const hallados = bloques.detectar(CONSOLA);
  const lineas = CONSOLA.split('\n');

  for (const b of hallados) {
    const definicion = bloques.definicionDe(b.clave);
    assert.ok(
      definicion.inicio.test(lineas[b.desde - 1]),
      `el bloque ${b.clave} no empieza en su marcador`,
    );
  }
});

test('«anova» NO casa con el veredicto de normalidad', () => {
  // El fallo que mató la búsqueda libre: `normalidad()` imprime «Puedes usar
  // pruebas parametricas: Pearson, t de Student, ANOVA», y buscar «ANOVA» daba
  // esa línea como única coincidencia. La ANOVA de verdad está mucho más abajo.
  const lineas = CONSOLA.split('\n');
  const veredicto = lineas.findIndex((l) => l.includes('pruebas parametricas')) + 1;

  assert.ok(veredicto > 0, 'el fixture tiene que traer el veredicto de normalidad');

  const anova = bloques.apariciones(CONSOLA, 'anova');
  assert.equal(anova.length, 1);
  assert.notEqual(anova[0].desde, veredicto);
  assert.ok(anova[0].desde > veredicto);
  assert.match(anova[0].texto, /Df Sum Sq Mean Sq F value/);
  assert.match(anova[0].texto, /2\.485/);
});

test('«pearson» tampoco casa con el chi-cuadrado de Pearson', () => {
  // R llama al chi-cuadrado «Pearson's Chi-squared test».
  const pearson = bloques.apariciones(CONSOLA, 'pearson');
  const chi = bloques.apariciones(CONSOLA, 'chi-cuadrado');

  assert.equal(pearson.length, 1);
  assert.equal(chi.length, 1);
  assert.match(pearson[0].texto, /product-moment/);
  assert.doesNotMatch(pearson[0].texto, /Chi-squared/);
  assert.match(chi[0].texto, /X-squared = 3\.693/);
});

test('el bloque de Pearson termina antes del aviso de Spearman', () => {
  // El aviso se imprime ANTES del encabezado del test al que pertenece, así que
  // sin recortar la cola se queda pegado al bloque anterior.
  const [pearson] = bloques.apariciones(CONSOLA, 'pearson');

  assert.match(pearson.texto, /0\.5111936/);
  assert.doesNotMatch(pearson.texto, /Warning/);
  assert.doesNotMatch(pearson.texto, /spearman/);
  assert.ok(!pearson.texto.endsWith('\n'));
});

test('los descriptivos aparecen dos veces y salen las dos', () => {
  // Una sobre los ítems y otra sobre los puntajes CD y EMP. Quedarse con una
  // sería decidir por el tesista cuál le interesa.
  const halladas = bloques.apariciones(CONSOLA, 'descriptivos');

  assert.equal(halladas.length, 2);
  assert.match(halladas[0].texto, /cd1/);
  assert.match(halladas[1].texto, /CD/);
  assert.match(halladas[1].texto, /EMP/);
  assert.ok(halladas[0].desde < halladas[1].desde);
});

test('las cifras que van al capítulo están dentro de su bloque', () => {
  const de = (clave) => bloques.apariciones(CONSOLA, clave)[0].texto;

  assert.match(de('alfa'), /Alfa de Cronbach: 0\.886/);
  assert.match(de('normalidad'), /W = 0\.9701/);
  assert.match(de('normalidad'), /p = 0\.1478/);
  assert.match(de('spearman'), /0\.4711889/);
  assert.match(de('regresion'), /Multiple R-squared:  0\.2613/);
  assert.match(de('regresion'), /0\.4858/);
  assert.match(de('t-student'), /t = -1\.5054/);
  assert.match(de('mann-whitney'), /W = 322/);
  assert.match(de('kruskal'), /chi-squared = 2\.4956/);
  assert.match(de('post-hoc'), /holm/);
  assert.match(de('frecuencias'), /61\.7/);
});

test('una consola vacía no rompe nada', () => {
  assert.deepEqual(bloques.detectar(''), []);
  assert.deepEqual(bloques.detectar(null), []);
  assert.deepEqual(bloques.detectar(undefined), []);
  assert.equal(bloques.lineasSueltas(''), 0);
});

test('una consola sin marcadores devuelve índice vacío', () => {
  const suelta = 'suma <- 2 + 2\n[1] 4\n> mean(x)\n[1] 3.5';

  assert.deepEqual(bloques.detectar(suelta), []);
  assert.equal(bloques.lineasSueltas(suelta), 4);
});

test('una clave que no está en el catálogo no rompe: no devuelve nada', () => {
  assert.equal(bloques.definicionDe('tabla-cruzada'), null);
  assert.equal(bloques.definicionDe('inventado'), null);
  assert.deepEqual(bloques.apariciones(CONSOLA, 'inventado'), []);
});

test('una prueba que no sabemos nombrar cae en el bloque anterior, sin perderse', () => {
  // Las medianas por grupo (`tapply`) no tienen marcador y quedan dentro de
  // Mann-Whitney. No se tiran, que es lo que importa.
  const [mw] = bloques.apariciones(CONSOLA, 'mann-whitney');
  assert.match(mw.texto, /2\.75/);
  assert.match(mw.texto, /3\.25/);
});

test('las líneas fuera de los bloques se cuentan, para poder pedirlas', () => {
  // Las 21 primeras del fixture son la carga, los head() y los dim().
  const sueltas = bloques.lineasSueltas(CONSOLA);
  assert.ok(sueltas > 0);
  assert.equal(sueltas, 164 - bloques.detectar(CONSOLA).reduce((s, b) => s + (b.hasta - b.desde + 1), 0));
});

test('los patrones del preámbulo son los que imprime nuestro webR', () => {
  // Cuatro de los catorce los imprime nuestro código, no R. Si alguien cambia
  // el preámbulo de `webr.service.ts` sin tocar esto, el índice se queda
  // corto en silencio: esta prueba es el aviso.
  const nuestros = bloques.BLOQUES.filter((b) => b.origen === 'preambulo').map((b) => b.clave);
  assert.deepEqual(nuestros.sort(), ['alfa', 'descriptivos', 'frecuencias', 'normalidad']);

  for (const clave of nuestros) {
    assert.ok(
      bloques.apariciones(CONSOLA, clave).length > 0,
      `${clave} debería aparecer en una consola de nuestro módulo`,
    );
  }
});

test('diez de los catorce patrones son formato de R y no dependen de nosotros', () => {
  const deR = bloques.BLOQUES.filter((b) => b.origen === 'R');
  assert.equal(deR.length, 10);
});

// ── El tramo pedido a mano ──────────────────────────────────────────────────

test('un tramo normal se sirve entero', () => {
  const t = bloques.tramo(CONSOLA, 54, 62);

  assert.equal(t.desde, 54);
  assert.equal(t.hasta, 62);
  assert.equal(t.recortado, false);
  assert.equal(t.siguiente, null);
  assert.match(t.texto, /Alfa de Cronbach: 0\.886/);
});

test('un tramo de más de 40 líneas se recorta y dice por dónde seguir', () => {
  const t = bloques.tramo(CONSOLA, 1, 120);

  assert.equal(t.pedidas, 120);
  assert.equal(t.desde, 1);
  assert.equal(t.hasta, 40);
  assert.equal(t.recortado, true);
  assert.equal(t.siguiente, 41);
  assert.equal(t.texto.split('\n').length, 40);
});

test('un tramo al revés o fuera de la consola se explica, no se adivina', () => {
  assert.equal(bloques.tramo(CONSOLA, 90, 20).error, 'al-reves');
  assert.equal(bloques.tramo(CONSOLA, 500, 600).error, 'fuera-de-rango');
  assert.equal(bloques.tramo(CONSOLA, 0, 10).error, 'fuera-de-rango');
  assert.equal(bloques.tramo(CONSOLA, 1.5, 10).error, 'no-entero');
  assert.equal(bloques.tramo(CONSOLA, 90, 20).total, 164);
});

test('un tramo que se pasa del final se queda en la última línea', () => {
  const t = bloques.tramo(CONSOLA, 160, 900);

  assert.equal(t.desde, 160);
  assert.equal(t.hasta, 164);
  assert.equal(t.recortado, false);
});
