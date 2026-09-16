'use strict';

/**
 * Lo que lee el Claude de un comprador sobre su proyecto, congelado.
 *
 * El panorama («mi_proyecto»), el contexto que viaja con el primer tramo de
 * «redactar» y los consejos de la plataforma, para tesis y para artículo. Todo
 * eso decide «tesis o artículo» por el producto, y es justo lo que se va a
 * tocar para añadir los informes. Ver `instantaneas/instantanea.js`.
 *
 * La base, el catálogo y el disco se sustituyen antes de cargar nada.
 */

const test = require('node:test');

const { comparar } = require('./instantaneas/instantanea');

const sustituir = (rutaRelativa, exports) => {
  const id = require.resolve(rutaRelativa);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';
const ARTICULO = 'ARTICULO_SCIENTIFICOS';
const INFORME = 'INFORME_ESTUDIANTIL';

/** Los catálogos nombrados como en producción: los nombres deciden fases y apoyos. */
const CATALOGOS = {
  [TESIS]: [
    { code: 'tema-y-delimitacion', displayName: '1 · Tema y delimitación' },
    { code: 'problema-y-objetivos', displayName: '2 · Capítulo I · Problema y objetivos' },
    { code: 'marco-teorico', displayName: '3 · Capítulo II · Marco teórico' },
    { code: 'metodologia', displayName: '4 · Capítulo III · Metodología' },
    { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' },
    { code: 'discusion', displayName: '8 · Capítulo V · Discusión' },
    { code: 'conclusiones-abstract', displayName: '9 · Capítulo VI · Conclusiones y resumen' },
    { code: 'humanizador-academico', displayName: 'Humanizador académico' },
    { code: 'bajar-similitud', displayName: 'Bajar similitud' },
  ],
  [ARTICULO]: [
    { code: 'articulo-fase0-tema-y-orientacion', displayName: 'Fase 0 — Tema y orientación' },
    { code: 'articulo-fase2-introduccion', displayName: 'Fase 2 — Introducción' },
    { code: 'articulo-fase3-revision-literatura', displayName: 'Fase 3 — Revisión de la literatura' },
    { code: 'articulo-fase5-resultados', displayName: 'Fase 5 — Resultados' },
    { code: 'articulo-fase6-discusion', displayName: 'Fase 6 — Discusión' },
    { code: 'humanizador-academico', displayName: 'Humanizador académico' },
  ],
  [INFORME]: [
    { code: 'informe-fase0-encargo', displayName: 'Fase 0 — El encargo' },
    { code: 'informe-fase1-fuentes', displayName: 'Fase 1 — Las fuentes' },
    { code: 'informe-fase2-desarrollo', displayName: 'Fase 2 — Desarrollo' },
    { code: 'informe-fase3-analisis-y-resultados', displayName: 'Fase 3 — Análisis y resultados' },
    { code: 'informe-fase4-cierre', displayName: 'Fase 4 — Conclusiones' },
    { code: 'humanizador-academico', displayName: 'Humanizador académico' },
  ],
};

const estado = { proyecto: null };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
  anotarConsejos: async () => {},
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async (productCode) => CATALOGOS[productCode] ?? [],
  findByCode: async (code) => {
    for (const catalogo of Object.values(CATALOGOS)) {
      const skill = catalogo.find((s) => s.code === code);
      if (skill) return { ...skill, productCodes: [] };
    }
    return null;
  },
  perteneceAlGrupo: () => true,
});
sustituir('../src/modules/projects/project.storage', {
  fechaDeAnalisis: async () => null,
  leer: async () => null,
  leerMaterial: async () => null,
});
sustituir('../src/modules/references/propias.repository', { contar: async () => 12 });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');
const consejos = require('../src/modules/projects/project.consejos');

const PROYECTOS = {
  [TESIS]: {
    id: 'p-tesis',
    productCode: TESIS,
    tema: 'Clima organizacional y desempeño docente en Lima, 2026',
    carrera: 'Psicología',
    universidad: 'UNMSM',
    asesor: null,
    estiloCitas: null,
    plantillaAt: null,
    consejos: null,
    updatedAt: new Date('2026-09-10T00:00:00Z'),
    stages: [
      { skillCode: 'tema-y-delimitacion', estado: 'LISTO', resumen: 'Tema delimitado.', datos: {} },
      { skillCode: 'problema-y-objetivos', estado: 'LISTO', resumen: 'Tres objetivos.', palabras: 6100 },
      { skillCode: 'marco-teorico', estado: 'EN_CURSO', resumen: 'Antecedentes a medias.', palabras: 1240 },
    ],
  },
  [ARTICULO]: {
    id: 'p-articulo',
    productCode: ARTICULO,
    tema: 'Adopción de pagos digitales en mypes',
    carrera: null,
    universidad: null,
    asesor: '',
    estiloCitas: null,
    plantillaAt: null,
    consejos: null,
    updatedAt: new Date('2026-09-10T00:00:00Z'),
    stages: [
      { skillCode: 'articulo-fase0-tema-y-orientacion', estado: 'LISTO', resumen: 'Revista Q2.' },
      { skillCode: 'articulo-fase2-introduccion', estado: 'EN_CURSO', palabras: 1800 },
    ],
  },
};

const AHORA = new Date('2026-09-15T12:00:00Z');

/**
 * Un informe de curso, el de los estudiantes que ya lo usan. Se congeló el 16 de
 * septiembre de 2026, antes de añadir el ámbito empresa a la misma ruta: el
 * estudiante no puede notar ese cambio.
 */
const INFORME_DE_CURSO = {
  id: 'p-informe',
  productCode: INFORME,
  tema: 'La informalidad laboral en los mercados de Lima',
  carrera: 'Administración de Empresas',
  universidad: 'Tecsup',
  asesor: null,
  estiloCitas: null,
  plantillaAt: null,
  consejos: null,
  fichaInforme: {
    tipo: 'curso',
    curso: 'Economía General',
    cicloSeccion: 'IV ciclo, sección B',
    integrantes: [{ nombre: 'Ana Ruiz', codigo: 'U2023001' }, { nombre: 'Luis Soto' }],
    fechaEntrega: '2026-09-30',
    rubrica: 'Introducción con objetivo; tres apartados con fuentes; APA 7.',
  },
  updatedAt: new Date('2026-09-10T00:00:00Z'),
  stages: [
    { skillCode: 'informe-fase0-encargo', estado: 'LISTO', resumen: 'Esquema de tres apartados.' },
    { skillCode: 'informe-fase2-desarrollo', estado: 'EN_CURSO', palabras: 1450 },
  ],
};

test('el panorama y el contexto de un informe de curso no cambian', async (t) => {
  // La línea de la entrega cuenta días desde hoy: se fija el reloj.
  t.mock.timers.enable({ apis: ['Date'], now: AHORA });
  estado.proyecto = structuredClone(INFORME_DE_CURSO);
  comparar(`proyecto.${INFORME}`, {
    resumen: await projectService.resumen('u1', INFORME),
    contexto: await projectService.contexto('u1', INFORME),
  });
});

for (const productCode of [TESIS, ARTICULO]) {
  test(`el panorama y el contexto de ${productCode} no cambian`, async () => {
    estado.proyecto = structuredClone(PROYECTOS[productCode]);
    comparar(`proyecto.${productCode}`, {
      resumen: await projectService.resumen('u1', productCode),
      contexto: await projectService.contexto('u1', productCode),
    });
  });

  test(`los consejos de ${productCode} no cambian`, async () => {
    estado.proyecto = structuredClone(PROYECTOS[productCode]);
    const apoyos = CATALOGOS[productCode]
      .filter((s) => !/^(\d|fase )/i.test(s.displayName))
      .map((s) => s.displayName);
    const esArticulo = productCode === ARTICULO;

    // De extremo a extremo: con texto y sin norma toca la norma, y sin formato, el formato.
    const deExtremo = await consejos.consejoPara({ userId: 'u1', productCode, ahora: AHORA });
    estado.proyecto = { ...structuredClone(PROYECTOS[productCode]), estiloCitas: 'apa' };
    const formato = await consejos.consejoPara({ userId: 'u1', productCode, ahora: AHORA });

    const claves = ['zotero-coleccion', 'fuentes', 'analisis', 'terminada', 'norma', 'formato'];
    comparar(`consejos.${productCode}`, {
      deExtremo,
      formato,
      textos: Object.fromEntries(claves.map((c) => [c, consejos.redactar(c, { esArticulo, apoyos })])),
    });
  });
}
