'use strict';

/**
 * El camino del análisis, desde la página de R hasta Claude.
 *
 * Tres cosas tienen que ser ciertas, y ninguna lo era antes de esta prueba:
 *
 *   · Lo que manda la web cae en el capítulo de resultados de SU método. El
 *     tesista no elige capítulo, y el de artículo no es el de tesis.
 *   · «mi_proyecto» avisa de que hay un análisis sin leer. Sin ese aviso el
 *     análisis se guarda y nadie lo abre: Claude no pregunta por lo que no sabe
 *     que existe.
 *   · El aviso se calla en cuanto hay cifras guardadas, que es la señal de que
 *     alguien ya lo leyó.
 *
 * El disco, la base y el catálogo se sustituyen antes de cargar el servicio: lo
 * que se comprueba es qué se guarda y qué lee el asistente, no cómo se escribe
 * un archivo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaSkills = require.resolve('../src/modules/skills/skill.service');
const rutaAlmacen = require.resolve('../src/modules/projects/project.storage');

const repo = {
  proyecto: null,
  buscar: async () => repo.proyecto,
  asegurar: async (userId, productCode) => {
    if (!repo.proyecto) repo.proyecto = { id: 'p1', productCode, stages: [] };
    return repo.proyecto;
  },
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
};

/** Un disco en memoria: `capitulo.tipo` → contenido. */
const almacen = {
  archivos: new Map(),
  guardarAnalisis: async (projectId, skillCode, { script, salida } = {}) => {
    const escritos = [];
    for (const [tipo, contenido] of Object.entries({ script, salida })) {
      if (!contenido) continue;
      almacen.archivos.set(`${skillCode}.${tipo}`, contenido);
      escritos.push(tipo);
    }
    return escritos;
  },
  leerAnalisis: async (projectId, skillCode, tipo) =>
    almacen.archivos.get(`${skillCode}.${tipo}`) ?? null,
  fechaDeAnalisis: async (projectId, skillCode) =>
    almacen.archivos.has(`${skillCode}.salida`) ? new Date('2026-09-10T12:00:00Z') : null,
};

const CATALOGOS = {
  METODO_9_SKILLS: [
    { code: 'tema-y-delimitacion', displayName: 'Tema y delimitación' },
    { code: 'analisis-datos-rstudio', displayName: 'Capítulo IV · Resultados' },
  ],
  ARTICULO_SCIENTIFICOS: [
    { code: 'articulo-fase0-tema-y-orientacion', displayName: 'Fase 0 — Tema' },
    { code: 'articulo-fase5-resultados', displayName: 'Fase 5 — Resultados' },
  ],
  SIN_RESULTADOS: [{ code: 'humanizador-academico', displayName: 'Humanizador' }],
};

require.cache[rutaRepo] = { id: rutaRepo, filename: rutaRepo, loaded: true, exports: repo };
require.cache[rutaAlmacen] = {
  id: rutaAlmacen,
  filename: rutaAlmacen,
  loaded: true,
  exports: almacen,
};
require.cache[rutaSkills] = {
  id: rutaSkills,
  filename: rutaSkills,
  loaded: true,
  exports: { listCatalog: async (productCode) => CATALOGOS[productCode] ?? [] },
};

const projectService = require('../src/modules/projects/project.service');

function empezar() {
  repo.proyecto = null;
  almacen.archivos.clear();
}

function enviarDesdeLaWeb(productCode = 'METODO_9_SKILLS') {
  return projectService.recibirAnalisis({
    userId: 'u1',
    productCode,
    script: 'cor.test(datos$CD, datos$EMP)',
    salida: 'cor 0.5108 p-value = 0.00003',
  });
}

test('lo que manda la web cae en el capítulo de resultados de la tesis', async () => {
  empezar();
  const recibido = await enviarDesdeLaWeb();

  assert.equal(recibido.capitulo, 'analisis-datos-rstudio');
  assert.deepEqual(recibido.escritos, ['script', 'salida']);
});

test('y en el de resultados del artículo, si el método es el artículo', async () => {
  empezar();
  const recibido = await enviarDesdeLaWeb('ARTICULO_SCIENTIFICOS');

  assert.equal(recibido.capitulo, 'articulo-fase5-resultados');
});

test('un método sin capítulo de resultados no guarda nada', async () => {
  empezar();
  const recibido = await enviarDesdeLaWeb('SIN_RESULTADOS');

  assert.equal(recibido, null);
  assert.equal(almacen.archivos.size, 0);
});

test('mi_proyecto avisa del análisis sin leer, aunque no haya ningún otro avance', async () => {
  empezar();
  await enviarDesdeLaWeb();

  const texto = await projectService.contexto('u1', 'METODO_9_SKILLS');

  assert.ok(texto, 'sin el aviso, el análisis se queda guardado y nadie lo abre');
  assert.match(texto, /ANÁLISIS SIN LEER/);
  assert.match(texto, /ver_analisis/);
});

test('el aviso se calla en cuanto hay cifras guardadas de ese análisis', async () => {
  empezar();
  await enviarDesdeLaWeb();
  repo.proyecto.tema = 'Competencias digitales y empleabilidad';
  repo.proyecto.stages = [
    {
      skillCode: 'analisis-datos-rstudio',
      estado: 'EN_CURSO',
      datos: { resultados: ['r de Pearson = 0.5108'] },
    },
  ];

  const texto = await projectService.contexto('u1', 'METODO_9_SKILLS');

  assert.ok(texto);
  assert.doesNotMatch(texto, /ANÁLISIS SIN LEER/);
});

test('sin análisis guardado no hay aviso, y un proyecto vacío sigue sin estorbar', async () => {
  empezar();
  repo.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [] };

  assert.equal(await projectService.contexto('u1', 'METODO_9_SKILLS'), null);
});

test('ver_analisis devuelve el script, la salida y las cifras ya guardadas', async () => {
  empezar();
  await enviarDesdeLaWeb();
  repo.proyecto.stages = [
    {
      skillCode: 'analisis-datos-rstudio',
      estado: 'EN_CURSO',
      datos: { resultados: ['r de Pearson = 0.5108'] },
    },
  ];

  const leido = await projectService.leerAnalisis('u1', 'METODO_9_SKILLS');

  assert.equal(leido.capitulo, 'analisis-datos-rstudio');
  assert.equal(leido.script, 'cor.test(datos$CD, datos$EMP)');
  assert.equal(leido.salida, 'cor 0.5108 p-value = 0.00003');
  assert.deepEqual(leido.cifras, ['r de Pearson = 0.5108']);
});

test('sin nada guardado, ver_analisis no presenta un análisis vacío', async () => {
  empezar();
  repo.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [] };

  assert.equal(await projectService.leerAnalisis('u1', 'METODO_9_SKILLS'), null);
});


// ── El contrato nuevo de ver_analisis: resumen, bloques y tramos ────────────

/**
 * Una consola con los marcadores REALES de R y de nuestro preámbulo.
 *
 * Es una versión corta de lo que devuelve webR en una sesión de Capítulo IV.
 * Los números de línea NO se escriben a mano en ninguna prueba: se buscan por
 * su marcador, que es justo lo que hace el código.
 */
const CONSOLA = [
  'Cargado «datos-tesis-ejemplo.csv» como datos.csv',
  '[1] 60 12',
  '  id sexo edad ciclo cd1 cd2 cd3 cd4',
  '1  1    F   22     X   3   3   3   4',
  "'data.frame':	60 obs. of  12 variables:",
  ' $ id   : int  1 2 3 4 5 6 7 8 9 10 ...',
  ' $ sexo : chr  "F" "F" "F" "F" ...',
  '      n media    de minimo maximo',
  'cd1  60  3.03  1.07      1      5',
  'cd2  60  2.90  1.12      1      5',
  ' categoria  n porcentaje acumulado',
  '         F 37       61.7      61.7',
  '         M 23       38.3     100.0',
  'Total: 60 casos',
  'Alfa de Cronbach: 0.886 ',
  'Items: 4  Casos: 60 ',
  '',
  'Si el alfa SUBE al quitar un item, ese item mide otra cosa:',
  '    r_item_resto alfa_si_se_quita',
  'cd1        0.763            0.850',
  '      n media   de minimo maximo',
  'CD  60  2.95 0.95   1.25      5',
  'EMP 60  2.78 0.90   1.00      5',
  'Shapiro-Wilk sobre la variable ',
  '  W = 0.9701    p = 0.1478    n = 60 ',
  '',
  'p >= 0.05: los datos NO se apartan de la normal.',
  'Puedes usar pruebas parametricas: Pearson, t de Student, ANOVA.',
  '',
  "	Pearson's product-moment correlation",
  '',
  'data:  datos$CD and datos$EMP',
  't = 4.5297, df = 58, p-value = 2.996e-05',
  'sample estimates:',
  '      cor ',
  '0.5111936 ',
  '',
  'Warning in cor.test.default(datos$CD, datos$EMP, method = "spearman") :',
  '  Cannot compute exact p-value with ties',
  '',
  "	Spearman's rank correlation rho",
  '',
  'S = 19032, p-value = 0.0001448',
  '      rho ',
  '0.4711889 ',
  '',
  'Call:',
  'lm(formula = EMP ~ CD, data = datos)',
  '',
  'Coefficients:',
  '            Estimate Std. Error t value Pr(>|t|)    ',
  '(Intercept)   1.3482     0.3325   4.055 0.000151 ***',
  'CD            0.4858     0.1072   4.530    3e-05 ***',
  '',
  'Multiple R-squared:  0.2613,	Adjusted R-squared:  0.2486 ',
  'F-statistic: 20.52 on 1 and 58 DF,  p-value: 2.996e-05',
  '',
  '	Welch Two Sample t-test',
  '',
  't = -1.5054, df = 40.029, p-value = 0.1401',
  '',
  '	Wilcoxon rank sum test with continuity correction',
  '',
  'W = 322, p-value = 0.1159',
  '                   Df Sum Sq Mean Sq F value Pr(>F)',
  'factor(datos$sexo)  1   2.18  2.1750   2.485   0.12',
  '',
  '	Kruskal-Wallis rank sum test',
  '',
  'Kruskal-Wallis chi-squared = 2.4956, df = 1, p-value = 0.1142',
  '',
  '	Pairwise comparisons using Wilcoxon rank sum test with continuity correction ',
  '',
  'P value adjustment method: holm ',
  '',
  "	Pearson's Chi-squared test with Yates' continuity correction",
  '',
  'X-squared = 3.693, df = 1, p-value = 0.05464',
].join('\n');

const SCRIPT_LARGO = [
  '# Guion de análisis · Capítulo IV',
  'datos <- read.csv("datos.csv")',
  'descriptivos(datos)',
  'alfa_de_cronbach(datos[, c("cd1","cd2","cd3","cd4")])',
  'datos$CD <- puntaje(datos, c("cd1","cd2","cd3","cd4"))',
  'normalidad(datos$CD)',
  'cor.test(datos$CD, datos$EMP)',
  'summary(lm(EMP ~ CD, data = datos))',
].join('\n');

/** La línea (desde 1) donde aparece un fragmento, buscada, nunca escrita a mano. */
function lineaDe(fragmento) {
  return CONSOLA.split('\n').findIndex((l) => l.includes(fragmento)) + 1;
}

async function conAnalisisCompleto(productCode = 'METODO_9_SKILLS') {
  empezar();
  await projectService.recibirAnalisis({
    userId: 'u1',
    productCode,
    script: SCRIPT_LARGO,
    salida: CONSOLA,
  });
}

const consultar = (opciones, productCode = 'METODO_9_SKILLS') =>
  projectService.consultarAnalisis('u1', productCode, opciones);

test('sin análisis guardado, consultarAnalisis devuelve null', async () => {
  empezar();
  repo.proyecto = { id: 'p1', productCode: 'METODO_9_SKILLS', stages: [] };

  assert.equal(await consultar({}), null);
});

test('el resumen dice qué hay, dónde está y cuánto ocupa', async () => {
  await conAnalisisCompleto();
  const t = await consultar({});

  assert.match(t, /ANÁLISIS GUARDADO · analisis-datos-rstudio/);
  assert.match(t, /Script: \d+ caracteres, 8 líneas/);
  assert.match(t, /Consola: [\d.]+ caracteres, \d+ líneas/);
  assert.match(t, /RESULTADOS EN LA CONSOLA \(\d+ bloques\)/);

  for (const clave of ['alfa', 'pearson', 'regresion', 'chi-cuadrado', 'anova']) {
    assert.ok(t.includes(clave), clave + ' debería salir en el índice');
  }
});

test('el resumen NO trae el script entero', async () => {
  await conAnalisisCompleto();
  const t = await consultar({});

  assert.doesNotMatch(t, /read\.csv/);
  assert.doesNotMatch(t, /summary\(lm/);
  assert.match(t, /bloque: "script"/);
});

test('el resumen NO trae las cifras: dice dónde están, no cuáles son', async () => {
  await conAnalisisCompleto();
  const t = await consultar({});

  assert.doesNotMatch(t, /0\.886/);
  assert.doesNotMatch(t, /0\.5111936/);
  assert.doesNotMatch(t, /0\.2613/);
  assert.match(t, /NO CUÁL ES/);
  assert.match(t, /Cifras guardadas: ninguna todavía/);
});

test('el resumen avisa de las líneas que no caen en ningún bloque', async () => {
  await conAnalisisCompleto();
  const t = await consultar({});

  assert.match(t, /líneas de consola fuera de esos bloques/);
  assert.match(t, /desde y hasta/);
});

test('bloque alfa: trae el alfa y su tabla, y nada más', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'alfa' });

  assert.match(t, /Alfa de Cronbach: 0\.886/);
  assert.match(t, /alfa_si_se_quita/);
  assert.match(t, new RegExp('líneas ' + lineaDe('Alfa de Cronbach:')));
  assert.doesNotMatch(t, /Shapiro/);
  assert.doesNotMatch(t, /product-moment/);
});

test('bloque pearson: trae r y p, sin el aviso de Spearman', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'pearson' });

  assert.match(t, /0\.5111936/);
  assert.match(t, /p-value = 2\.996e-05/);
  assert.doesNotMatch(t, /Warning/);
  assert.doesNotMatch(t, /rank correlation/);
});

test('bloque regresion: trae los coeficientes y la R cuadrado', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'regresion' });

  assert.match(t, /lm\(formula = EMP ~ CD/);
  assert.match(t, /0\.4858/);
  assert.match(t, /Multiple R-squared:  0\.2613/);
});

test('bloque chi-cuadrado: el de Pearson de verdad, no la correlación', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'chi-cuadrado' });

  assert.match(t, /X-squared = 3\.693/);
  assert.doesNotMatch(t, /product-moment/);
  assert.doesNotMatch(t, /0\.5111936/);
});

test('bloque descriptivos: salen las DOS apariciones, numeradas', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'descriptivos' });

  assert.match(t, /2 apariciones/);
  assert.match(t, /cd1/);
  assert.match(t, /EMP 60/);
  assert.equal((t.match(/── líneas /g) ?? []).length, 2);
});

test('bloque script: el guion entero', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'script' });

  assert.match(t, /SCRIPT DE R/);
  assert.match(t, /read\.csv/);
  assert.match(t, /summary\(lm\(EMP ~ CD, data = datos\)\)/);
});

test('bloque todo: la consola completa, como antes de la Fase 2', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'todo' });

  assert.match(t, /CONSOLA COMPLETA/);
  assert.ok(t.includes(CONSOLA), 'tiene que ir la consola entera, sin recortar');
});

test('un tramo pedido a mano devuelve esas líneas', async () => {
  await conAnalisisCompleto();
  const alfa = lineaDe('Alfa de Cronbach:');
  const t = await consultar({ desde: alfa, hasta: alfa + 1 });

  assert.match(t, new RegExp('líneas ' + alfa + '-' + (alfa + 1)));
  assert.match(t, /Alfa de Cronbach: 0\.886/);
  assert.match(t, /Items: 4/);
  assert.doesNotMatch(t, /Shapiro/);
});

test('un tramo de más de 40 líneas se recorta y dice por dónde seguir', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ desde: 1, hasta: 200 });

  assert.match(t, /Pediste \d+ líneas/);
  assert.match(t, /van las primeras 40/);
  assert.match(t, /Sigue con desde: 41/);
});

test('un tramo al revés o fuera de la consola se explica', async () => {
  await conAnalisisCompleto();

  assert.match(await consultar({ desde: 50, hasta: 10 }), /tiene que ser menor o igual/);
  assert.match(await consultar({ desde: 5000, hasta: 5010 }), /Ese tramo no existe/);
  assert.match(await consultar({ desde: 5000, hasta: 5010 }), /de 1 a \d+/);
});

test('un bloque que no existe enumera los válidos, sin adivinar', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'inventado' });

  assert.match(t, /no es un bloque de análisis/);
  assert.match(t, /alfa/);
  assert.match(t, /chi-cuadrado/);
});

test('un bloque válido que no está en ESTA consola lo dice, y no da otro', async () => {
  empezar();
  await projectService.recibirAnalisis({
    userId: 'u1',
    productCode: 'METODO_9_SKILLS',
    script: 'descriptivos(datos)',
    salida: ['      n media    de minimo maximo', 'cd1  60  3.03  1.07      1      5'].join('\n'),
  });

  const t = await consultar({ bloque: 'regresion' });

  assert.match(t, /no aparece ningún bloque de regresión lineal/);
  assert.match(t, /Lo que sí hay: descriptivos/);
  assert.doesNotMatch(t, /3\.03/, 'no debe colar otro bloque como si fuera el pedido');
});

test('si vienen bloque y tramo a la vez, gana el bloque y se dice', async () => {
  await conAnalisisCompleto();
  const t = await consultar({ bloque: 'alfa', desde: 1, hasta: 5 });

  assert.match(t, /Alfa de Cronbach: 0\.886/);
  assert.match(t, /te doy el bloque/);
  assert.doesNotMatch(t, /Cargado «datos-tesis-ejemplo/);
});

test('el análisis del artículo funciona igual, en su propio capítulo', async () => {
  await conAnalisisCompleto('ARTICULO_SCIENTIFICOS');
  const t = await consultar({}, 'ARTICULO_SCIENTIFICOS');

  assert.match(t, /ANÁLISIS GUARDADO · articulo-fase5-resultados/);
  assert.match(t, /alfa/);

  const bloque = await consultar({ bloque: 'alfa' }, 'ARTICULO_SCIENTIFICOS');
  assert.match(bloque, /0\.886/);
});

test('una licencia de tesis no ve el análisis del artículo', async () => {
  // Cada proyecto es de un (usuario, producto): el de tesis no alcanza al del
  // artículo aunque sea el mismo usuario. El aislamiento por clave de capítulo
  // lo hace además el handler, con findByCode y perteneceAlGrupo.
  await conAnalisisCompleto('ARTICULO_SCIENTIFICOS');
  repo.proyecto = { id: 'otro', productCode: 'METODO_9_SKILLS', stages: [] };

  assert.equal(await consultar({}, 'METODO_9_SKILLS'), null);
});

test('un método sin capítulo de resultados no tiene nada que consultar', async () => {
  await conAnalisisCompleto();

  assert.equal(await consultar({}, 'SIN_RESULTADOS'), null);
});

test('leerAnalisis conserva su forma: cuatro campos, ni uno más', async () => {
  // Es un contrato: lo usan el handler antiguo y las pruebas de arriba.
  await conAnalisisCompleto();
  const leido = await projectService.leerAnalisis('u1', 'METODO_9_SKILLS');

  assert.deepEqual(Object.keys(leido).sort(), ['capitulo', 'cifras', 'salida', 'script']);
  assert.equal(leido.capitulo, 'analisis-datos-rstudio');
  assert.equal(leido.salida, CONSOLA);
});
