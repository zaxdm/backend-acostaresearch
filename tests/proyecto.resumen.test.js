'use strict';

/**
 * El panorama y el detalle: las dos mitades en que se parte lo que antes iba
 * junto.
 *
 * Lo que se prueba aquí es el texto que acaba leyendo el asistente, igual que
 * en `proyecto.memoria`. Tres cosas tienen que ser ciertas:
 *
 *   · «mi_proyecto» dice dónde está y qué le toca, y NO arrastra los acuerdos
 *     de los diez capítulos. Ese arrastre era el gasto que se viene a quitar.
 *   · No se pierde el aviso del análisis sin leer por el camino: vivía dentro
 *     de `contexto`, y `mi_proyecto` ya no lo llama.
 *   · «ver_capitulo» devuelve el acuerdo, nunca el texto redactado, y no deja
 *     leer un capítulo que no es de esa licencia.
 *
 * La base, el catálogo y el disco se sustituyen antes de cargar el servicio.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaSkills = require.resolve('../src/modules/skills/skill.service');
const rutaAlmacen = require.resolve('../src/modules/projects/project.storage');

const repo = {
  proyecto: null,
  buscar: async () => repo.proyecto,
  asegurar: async () => repo.proyecto,
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
};

/**
 * El catálogo, nombrado como en producción.
 *
 * Las fases llevan su número delante y las herramientas de apoyo no: es lo que
 * mira `esApoyo` para separar el avance del método de lo que se usa cuando hace
 * falta. Un catálogo de prueba sin numerar no representa a ninguna licencia
 * real, y fue lo que dejó pasar que los recuentos contaran el humanizador como
 * un capítulo sin empezar.
 */
const CATALOGO = [
  { code: 'tema-y-delimitacion', displayName: '1 · Tema y delimitación' },
  { code: 'problema-y-objetivos', displayName: '2 · Problema y objetivos' },
  { code: 'metodologia', displayName: '3 · Metodología' },
  { code: 'analisis-datos-rstudio', displayName: '4 · Análisis de datos en RStudio' },
  { code: 'humanizador-academico', displayName: 'Humanizador académico' },
  { code: 'bajar-similitud', displayName: 'Bajar similitud' },
];

/** Las fases del método, sin las herramientas de apoyo. */
const FASES = CATALOGO.filter((s) => /^\d/.test(s.displayName));

/** Qué capítulos son de qué método. Sin grupos = de todos, como en el real. */
const GRUPOS = { 'capitulo-de-otro-metodo': ['ARTICULO_SCIENTIFICOS'] };

const skills = {
  listCatalog: async () => CATALOGO,
  findByCode: async (code) => {
    const suyo = CATALOGO.find((s) => s.code === code);
    if (suyo) return { ...suyo, productCodes: GRUPOS[code] ?? [] };
    if (GRUPOS[code]) return { code, displayName: 'De otro método', productCodes: GRUPOS[code] };
    return null;
  },
  // Misma regla que `skillService.perteneceAlGrupo`: sin grupos, es de todos.
  perteneceAlGrupo: (skill, productCode) => {
    const suyos = skill.productCodes ?? [];
    return suyos.length === 0 || suyos.includes(productCode);
  },
};

const almacen = {
  hayAnalisis: false,
  leidos: [],
  fechaDeAnalisis: async (projectId, skillCode) =>
    almacen.hayAnalisis && skillCode === 'analisis-datos-rstudio'
      ? new Date('2026-08-14T12:00:00Z')
      : null,
  leer: async (projectId, skillCode) => {
    almacen.leidos.push(skillCode);
    return 'El texto redactado del capítulo, que aquí no debería salir jamás.';
  },
};

require.cache[rutaRepo] = { id: rutaRepo, filename: rutaRepo, loaded: true, exports: repo };
require.cache[rutaSkills] = { id: rutaSkills, filename: rutaSkills, loaded: true, exports: skills };
require.cache[rutaAlmacen] = {
  id: rutaAlmacen,
  filename: rutaAlmacen,
  loaded: true,
  exports: almacen,
};

const projectService = require('../src/modules/projects/project.service');
const etapas = require('../src/modules/projects/project.etapas');

const PRODUCTO = 'METODO_9_SKILLS';

function conProyecto(datos) {
  almacen.hayAnalisis = false;
  almacen.leidos = [];
  repo.proyecto = { id: 'p1', productCode: PRODUCTO, stages: [], ...datos };
}

/** Una tesis a media escritura, que es el caso que paga el gasto. */
function aMedias() {
  conProyecto({
    tema: 'Clima organizacional y desempeño docente',
    carrera: 'Psicología',
    universidad: 'UNMSM',
    stages: [
      {
        skillCode: 'tema-y-delimitacion',
        estado: 'LISTO',
        resumen: 'ACUERDO DEL PRIMERO que no debe salir en el panorama.',
        datos: { poblacion: 'Docentes de secundaria' },
      },
      {
        skillCode: 'problema-y-objetivos',
        estado: 'LISTO',
        resumen: 'ACUERDO DEL SEGUNDO que tampoco debe salir.',
        palabras: 6100,
      },
      {
        skillCode: 'metodologia',
        estado: 'EN_CURSO',
        resumen: 'Se acordó muestreo estratificado.',
        palabras: 1240,
        textoAt: new Date('2026-08-11T09:00:00Z'),
        datos: { enfoque: 'Cuantitativo', diseno: 'No experimental', muestra: '184 docentes' },
      },
    ],
  });
}

// ── El panorama ─────────────────────────────────────────────────────────────

test('sin proyecto no hay panorama, igual que en contexto', async () => {
  repo.proyecto = null;
  assert.equal(await projectService.resumen('u1', PRODUCTO), null);
});

test('un proyecto que existe pero no tiene nada que contar tampoco estorba', async () => {
  conProyecto({
    tema: null,
    stages: [{ skillCode: 'tema-y-delimitacion', estado: 'PENDIENTE', resumen: null }],
  });
  assert.equal(await projectService.resumen('u1', PRODUCTO), null);
});

test('el panorama dice dónde está: tema, sitio, marcas, claves y recuentos', async () => {
  aMedias();

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.match(t, /Clima organizacional y desempeño docente/);
  assert.match(t, /Psicología · UNMSM/);

  // Las marcas son las de siempre. Dos vocabularios para lo mismo sería peor
  // que uno feo.
  assert.match(t, /\[hecho\]\s+1 · Tema y delimitación\s+\(tema-y-delimitacion\)/);
  assert.match(t, /\[en curso\]\s+3 · Metodología\s+\(metodologia\)/);
  assert.match(t, /\[pendiente\]\s+4 · Análisis de datos en RStudio\s+\(analisis-datos-rstudio\)/);

  assert.match(t, /2 cerrados · 1 en curso · 1 sin empezar/);
  assert.match(t, /7\.340 palabras guardadas/);
  assert.match(t, /1\.240 palabras/);

  assert.match(t, /Le toca: 3 · Metodología \(clave: metodologia\)/);
});

test('las herramientas de apoyo se listan pero NO cuentan como avance', async () => {
  // El avance es de las fases. Contar el humanizador y la bajada de similitud
  // dejaba en «9 de 11» a quien había terminado los nueve capítulos, que es el
  // mismo motivo por el que el panel ya las separa con `esApoyo`.
  aMedias();

  const t = await projectService.resumen('u1', PRODUCTO);

  // Salen en la lista: el tesista las ha comprado y tiene que saber que están.
  assert.match(t, /\[pendiente\]\s+Humanizador académico\s+\(humanizador-academico\)/);
  assert.match(t, /\[pendiente\]\s+Bajar similitud\s+\(bajar-similitud\)/);

  // Pero el recuento es de las 4 fases, no de las 6 entradas.
  assert.equal(FASES.length, 4);
  assert.equal(CATALOGO.length, 6);
  assert.match(t, /2 cerrados · 1 en curso · 1 sin empezar/);
  assert.doesNotMatch(t, /3 sin empezar/, 'contar el apoyo daba 3 en vez de 1');
});

test('con un solo capítulo cerrado dice «1 cerrado», no «1 cerrados»', async () => {
  conProyecto({
    tema: 'Un tema',
    stages: [
      { skillCode: 'tema-y-delimitacion', estado: 'LISTO' },
      { skillCode: 'metodologia', estado: 'EN_CURSO' },
    ],
  });

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.match(t, /1 cerrado · 1 en curso · 2 sin empezar/);
  assert.doesNotMatch(t, /1 cerrados/);
});

test('con dos o más dice «cerrados», y con cero también', async () => {
  aMedias();
  assert.match(await projectService.resumen('u1', PRODUCTO), /2 cerrados/);

  conProyecto({ tema: 'Un tema', stages: [{ skillCode: 'metodologia', estado: 'EN_CURSO' }] });
  assert.match(await projectService.resumen('u1', PRODUCTO), /0 cerrados · 1 en curso/);
});

test('«en curso» y «sin empezar» no cambian de forma con el número', async () => {
  conProyecto({
    tema: 'Un tema',
    stages: [{ skillCode: 'tema-y-delimitacion', estado: 'EN_CURSO' }],
  });

  const t = await projectService.resumen('u1', PRODUCTO);
  assert.match(t, /0 cerrados · 1 en curso · 3 sin empezar/);
});

test('el panorama NO arrastra los acuerdos de todos los capítulos', async () => {
  // Es el cambio entero: eso costaba miles de tokens en cada conversación
  // nueva y se quedaba ocupando la ventana hasta el final.
  aMedias();

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.doesNotMatch(t, /ACUERDO DEL PRIMERO/);
  assert.doesNotMatch(t, /ACUERDO DEL SEGUNDO/);
  assert.doesNotMatch(t, /Se acordó muestreo estratificado/);
  assert.doesNotMatch(t, /Enfoque: Cuantitativo/);

  // Pero tiene que decir que existen y cómo pedirlos, o el asistente dará por
  // hecho que no hay nada y volverá a preguntárselo al tesista.
  assert.match(t, /LO ACORDADO EN CADA CAPÍTULO ESTÁ GUARDADO/);
  assert.match(t, /ver_capitulo/);
  assert.match(t, /NO le hagas repetir lo que ya está decidido/);
});

test('el panorama avisa en una línea de lo que falta para el capítulo que toca', async () => {
  aMedias();

  const t = await projectService.resumen('u1', PRODUCTO);

  // Metodología necesita objetivo general y variables, y no están puestos.
  assert.match(t, /Antes de empezarlo falta fijar: .*Objetivo general/);
  assert.match(t, /Variables/);
});

test('cuando está todo cerrado lo dice, en vez de inventarse un siguiente', async () => {
  conProyecto({
    tema: 'Un tema',
    stages: CATALOGO.map((s) => ({ skillCode: s.code, estado: 'LISTO' })),
  });

  const t = await projectService.resumen('u1', PRODUCTO);
  assert.match(t, /Tiene todos los capítulos dados por buenos/);
});

test('con las FASES cerradas y el apoyo pendiente, también dice que terminó', async () => {
  // El caso real: nadie cierra «Bajar similitud», así que antes de la Fase 3
  // el panorama decía «Le toca: Bajar similitud» y el tesista que había
  // acabado su tesis no se enteraba de que había acabado.
  conProyecto({
    tema: 'Un tema',
    stages: FASES.map((s) => ({ skillCode: s.code, estado: 'LISTO' })),
  });

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.match(t, /Tiene todos los capítulos dados por buenos/);
  assert.doesNotMatch(t, /Le toca/);
  assert.doesNotMatch(t, /Bajar similitud \(clave/);

  // Y siguen listadas: no se han quitado del catálogo, solo del avance.
  assert.match(t, /\[pendiente\]\s+Bajar similitud\s+\(bajar-similitud\)/);
  assert.match(t, /\[pendiente\]\s+Humanizador académico\s+\(humanizador-academico\)/);
  assert.match(t, /4 cerrados · 0 en curso · 0 sin empezar/);
});

test('sin tema ni carrera, el panorama no empieza por una línea en blanco', async () => {
  // Pasa de verdad: quien manda su análisis desde la web tiene avance antes de
  // haber dicho el tema. La cabecera vacía dejaba la respuesta empezando por un
  // salto de línea.
  conProyecto({
    tema: null,
    carrera: null,
    universidad: null,
    stages: [{ skillCode: 'metodologia', estado: 'EN_CURSO' }],
  });

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.doesNotMatch(t, /^\s/, 'no debe empezar por un espacio ni un salto');
  assert.doesNotMatch(t, /\n\n\n/, 'ni dejar secciones en blanco por el medio');
  assert.match(t, /^\[pendiente\] 1 · Tema y delimitación/);
});

test('un estado que no esté en MARCAS no tumba el panorama', async () => {
  // El enum de Prisma tiene tres valores, así que hoy no puede llegar otro.
  // Pero esto se lee al empezar cada conversación: si algún día se añade uno,
  // tiene que contarse como pendiente, no dejar al tesista sin panorama.
  conProyecto({
    tema: 'Un tema',
    stages: [{ skillCode: 'metodologia', estado: 'EN_REVISION' }],
  });

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.match(t, /\[pendiente\] 3 · Metodología/);
  assert.match(t, /0 cerrados · 0 en curso · 4 sin empezar/);
});

// ── El aviso del análisis, que vivía dentro de contexto ─────────────────────

test('el panorama avisa del análisis sin leer', async () => {
  // Sin esto, el análisis se queda guardado y nadie lo abre: mi_proyecto dejó
  // de llamar a contexto, que era donde vivía el aviso.
  aMedias();
  almacen.hayAnalisis = true;

  const t = await projectService.resumen('u1', PRODUCTO);

  assert.match(t, /ANÁLISIS SIN LEER/);
  assert.match(t, /ver_analisis/);
});

test('y se calla en cuanto hay cifras guardadas de ese análisis', async () => {
  aMedias();
  almacen.hayAnalisis = true;
  repo.proyecto.stages.push({
    skillCode: 'analisis-datos-rstudio',
    estado: 'EN_CURSO',
    datos: { resultados: ['r de Pearson = 0.5108'] },
  });

  const t = await projectService.resumen('u1', PRODUCTO);
  assert.doesNotMatch(t, /ANÁLISIS SIN LEER/);
});

test('el aviso solo ya justifica el panorama, aunque no haya ningún otro avance', async () => {
  conProyecto({ tema: null, stages: [] });
  almacen.hayAnalisis = true;

  const t = await projectService.resumen('u1', PRODUCTO);
  assert.ok(t, 'un análisis sin leer es algo que contar');
  assert.match(t, /ANÁLISIS SIN LEER/);
});

// ── El detalle de un capítulo ───────────────────────────────────────────────

test('el detalle trae el acuerdo, los campos puestos y los que faltan', async () => {
  aMedias();

  const t = await projectService.detalleDeCapitulo('u1', PRODUCTO, 'metodologia');

  assert.match(
    t,
    /3 · Metodología \(metodologia\) · \[en curso\] · 1\.240 palabras, guardadas el 2026-08-11/,
  );

  assert.match(t, /LO ACORDADO/);
  assert.match(t, /Enfoque: Cuantitativo/);
  assert.match(t, /Muestra: 184 docentes/);
  assert.match(t, /quedó así: Se acordó muestreo estratificado\./);

  assert.match(t, /CAMPOS DE ESTE CAPÍTULO/);
  assert.match(t, /enfoque — /);
  assert.match(t, /analisis \(lista\) — /);
  assert.match(t, /SIN FIJAR: nivel, muestreo, tecnica, instrumento, analisis/);

  assert.match(t, /ANTES DE REDACTAR: falta fijar .*Objetivo general/);
});

test('el detalle NO devuelve el texto redactado del capítulo', async () => {
  // Devolverlo sería cambiar un volcado por otro. De lo escrito solo sale
  // cuánto ocupa y de cuándo es.
  aMedias();

  const t = await projectService.detalleDeCapitulo('u1', PRODUCTO, 'metodologia');

  assert.doesNotMatch(t, /El texto redactado del capítulo/);
  assert.deepEqual(almacen.leidos, [], 'no debe ni abrir el archivo del capítulo');
});

test('un capítulo sin tocar devuelve sus campos y dice cuáles están sin fijar', async () => {
  aMedias();

  const t = await projectService.detalleDeCapitulo('u1', PRODUCTO, 'problema-y-objetivos');

  assert.match(t, /2 · Problema y objetivos \(problema-y-objetivos\)/);
  assert.match(t, /SIN FIJAR: problemaGeneral, objetivoGeneral, objetivosEspecificos/);
});

test('un capítulo con todos los campos puestos lo dice en vez de listar nada', async () => {
  conProyecto({
    tema: 'Un tema',
    stages: [
      {
        skillCode: 'tema-y-delimitacion',
        estado: 'LISTO',
        datos: { poblacion: 'Docentes', ambito: 'Lima', periodo: '2025-2026' },
      },
    ],
  });

  const t = await projectService.detalleDeCapitulo('u1', PRODUCTO, 'tema-y-delimitacion');
  assert.match(t, /Están todos fijados\./);
});

test('un capítulo que no existe no devuelve nada', async () => {
  aMedias();
  assert.equal(await projectService.detalleDeCapitulo('u1', PRODUCTO, 'inventado'), null);
});

test('un capítulo de otro método no se puede leer con esta licencia', async () => {
  // La clave de un capítulo no es ningún secreto: que no salga en el catálogo
  // no impide pedirlo por su nombre.
  aMedias();

  assert.equal(
    await projectService.detalleDeCapitulo('u1', PRODUCTO, 'capitulo-de-otro-metodo'),
    null,
  );
});

// ── El catálogo de campos de una sola etapa ─────────────────────────────────

test('camposDe devuelve solo los campos de la etapa que se pide', async () => {
  const campos = etapas.camposDe('metodologia');

  assert.deepEqual(
    campos.map((c) => c.clave),
    ['enfoque', 'diseno', 'nivel', 'muestra', 'muestreo', 'tecnica', 'instrumento', 'analisis'],
  );

  const analisis = campos.find((c) => c.clave === 'analisis');
  assert.equal(analisis.lista, true);
  assert.ok(analisis.pista, 'la pista es lo que hace que el campo se pueda rellenar bien');
  assert.equal(campos.find((c) => c.clave === 'enfoque').lista, false);
});

test('una etapa sin campos registrados devuelve lista vacía, no un error', async () => {
  assert.deepEqual(etapas.camposDe('conclusiones'), []);
});

test('el catálogo entero sigue saliendo igual, ahora armado desde camposDe', async () => {
  const catalogo = etapas.catalogoParaElAsistente();
  const metodologia = catalogo.find((linea) => linea.startsWith('metodologia:'));

  assert.ok(metodologia);
  assert.match(metodologia, /enfoque — /);
  assert.match(metodologia, /analisis \(lista\) — /);
});
