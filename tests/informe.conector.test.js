'use strict';

/**
 * El conector del informe estudiantil.
 *
 * Lo que tiene que ser cierto:
 *
 *   · la revisión se llama «revisar_el_informe» y habla de la rúbrica, no de
 *     variables ni objetivos de tesis;
 *   · guardar_capitulo admite las claves de las secciones aparte y habla del
 *     informe y del estudiante;
 *   · el informe tiene las mismas herramientas que la tesis, ni una más;
 *   · los consejos de norma y formato hablan del docente y del instituto;
 *   · el .bib y el repaso leen también el resumen y la introducción.
 *
 * Que tesis y artículo no cambian lo vigilan las instantáneas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const INFORME = 'INFORME_ESTUDIANTIL';
const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';

const estado = { proyecto: null, textos: {}, pedidas: [] };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  nombreDe: async () => 'Alguien',
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/projects/project.storage', {
  leer: async (projectId, clave) => estado.textos[clave] ?? null,
  palabrasDe: (texto) => String(texto).split(/\s+/).filter(Boolean).length,
  leerPlantilla: async () => null,
  fechaDeAnalisis: async () => null,
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [{ code: 'informe-fase2-desarrollo', displayName: 'Fase 2 — Desarrollo' }],
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});
sustituir('../src/modules/references/reference.service', {
  porClaves: async (claves) => {
    estado.pedidas.push(...claves);
    return [];
  },
});

const rutaMcp = require.resolve('@modelcontextprotocol/server');
const mcpReal = require('@modelcontextprotocol/server');
let registradas = null;
require.cache[rutaMcp] = {
  id: rutaMcp,
  filename: rutaMcp,
  loaded: true,
  exports: {
    fromJsonSchema: mcpReal.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');
const consejos = require('../src/modules/projects/project.consejos');
const projectService = require('../src/modules/projects/project.service');

function herramientas(productCode) {
  registradas = new Map();
  construirServidor({ productCode });
  return registradas;
}

const esquema = (config) => config.inputSchema['~standard'].jsonSchema.input();

// ── Las herramientas ───────────────────────────────────────────────────────

test('el informe tiene las herramientas de la tesis más el material del curso, con su revisión', () => {
  const informe = herramientas(INFORME);
  const tesis = herramientas(TESIS);

  assert.equal(informe.size, tesis.size + 1);
  assert.ok(informe.has('material_del_curso'));
  assert.ok(informe.has('revisar_el_informe'));
  assert.ok(!informe.has('revisar_la_tesis'));
});

test('la revisión del informe habla de la rúbrica y no de variables', () => {
  const d = herramientas(INFORME).get('revisar_el_informe').description;
  assert.match(d, /rúbrica/);
  assert.match(d, /ESTUDIANTE/);
  assert.doesNotMatch(d, /variables|TESISTA/);
});

test('guardar_capitulo del informe admite sus secciones aparte y no habla de la tesis', () => {
  const e = esquema(herramientas(INFORME).get('guardar_capitulo'));
  assert.match(e.properties.capitulo.description, /informe-introduccion/);
  assert.match(e.properties.capitulo.description, /informe-resumen/);
  assert.doesNotMatch(e.properties.texto.description, /tesis/);
  assert.match(e.properties.texto.description, /LAS TABLAS/, 'lo demás se queda');
});

test('guardar_capitulo de la tesis sigue igual', () => {
  const e = esquema(herramientas(TESIS).get('guardar_capitulo'));
  assert.equal(e.properties.capitulo.description, 'Clave del capítulo, tal como aparece en listar_capitulos.');
  assert.match(e.properties.texto.description, /tal y como va a la tesis/);
});

// ── Los consejos ───────────────────────────────────────────────────────────

test('en el informe, la norma se le pregunta al docente y el formato, al instituto', () => {
  assert.match(consejos.redactar('norma', { tipo: 'informe', obra: 'su informe' }), /su docente/);
  const formato = consejos.redactar('formato', { tipo: 'informe', obra: 'su informe' });
  assert.match(formato, /instituto/);
  assert.match(formato, /su informe/);
  assert.match(formato, /formato_de_la_universidad/);
});

test('sin tipo, los consejos son los de siempre', () => {
  assert.match(consejos.redactar('norma'), /su universidad o su asesor/);
  assert.match(consejos.redactar('formato', { obra: 'su tesis' }), /su facultad/);
});

// ── Lo que recorre lo escrito ──────────────────────────────────────────────

function informeConCitas() {
  estado.pedidas = [];
  estado.textos = {
    'informe-introduccion': 'Según la OIT [AR11111111], la informalidad crece.',
    'informe-fase2-desarrollo': 'Las causas son varias [AR22222222].',
  };
  estado.proyecto = {
    id: 'p1',
    productCode: INFORME,
    tema: 'Informalidad',
    stages: [
      { skillCode: 'informe-introduccion', estado: 'EN_CURSO', palabras: 8 },
      { skillCode: 'informe-fase2-desarrollo', estado: 'EN_CURSO', palabras: 6 },
    ],
  };
}

test('el .bib del informe busca también las citas de la introducción', async () => {
  informeConCitas();
  await projectService.armarBibtex('u1', INFORME);
  assert.deepEqual([...new Set(estado.pedidas)].sort(), ['AR11111111', 'AR22222222']);
});

test('el repaso del informe lee también la introducción', async () => {
  informeConCitas();
  await projectService.auditar('u1', INFORME).catch(() => null);
  assert.ok(estado.pedidas.includes('AR11111111'), 'las citas de la introducción entran en el repaso');
});

test('en una tesis, una clave de sección aparte no entra en el .bib', async () => {
  informeConCitas();
  estado.proyecto.productCode = TESIS;
  await projectService.armarBibtex('u1', TESIS);
  assert.ok(!estado.pedidas.includes('AR11111111'));
});
