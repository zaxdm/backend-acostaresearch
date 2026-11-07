'use strict';

/**
 * El Word del artículo empírico sale como manuscrito de revista (E2E del
 * 7-nov-2026). Salía con portada de tesis («Tesis», «Autor:», el año), con
 * índice, con «[TITULO] …» impreso y con «Introducción» dos veces.
 *
 * La base, el disco, el catálogo y las fichas se sustituyen; el Word es el de
 * verdad, armado por `projectService.armarWord`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const estado = { proyecto: null, textos: {} };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  nombreDe: async () => 'Benicio Acosta Enríquez',
  listarDeUsuario: async () => (estado.proyecto ? [estado.proyecto] : []),
  productosConLicencia: async () => ['ARTICULO_SCIENTIFICOS'],
  productosConVariasTesis: async () => [],
  nombresDeProducto: async () => new Map(),
  guardarEtapa: async () => ({}),
});

sustituir('../src/modules/projects/project.storage', {
  leerFichaDeDocumento: async () => null,
  leer: async (projectId, clave) => estado.textos[clave] ?? null,
  leerPlantilla: async () => null,
  leerVerificacion: async () => ({}),
});

sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [
    { code: 'articulo-fase0-tema-y-orientacion', displayName: 'Fase 0 — Tema y orientación' },
    { code: 'articulo-fase1-matriz-de-estrategia', displayName: 'Fase 1 — Matriz de Estrategia' },
    { code: 'articulo-fase2-introduccion', displayName: 'Fase 2 — Introducción' },
  ],
  findByCode: async () => null,
});

sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });
sustituir('../src/modules/mendeley/mendeley.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

const INTRODUCCION = [
  '[TITULO] Dependencia de ChatGPT y pensamiento crítico en universitarios',
  '',
  '## Introducción',
  '',
  'El uso de la inteligencia artificial generativa se volvió casi general.',
  '',
  '## Vacío y objetivo',
  '',
  'Todavía no se sabe por qué ocurre esa relación.',
].join('\n');

function empezar(cambios = {}) {
  estado.textos = {
    'articulo-fase0-tema-y-orientacion': 'La Ficha.',
    'articulo-fase1-matriz-de-estrategia': '## Diseño\n| Campo | Contenido |\n|---|---|\n| Enfoque | Cuantitativo |',
    'articulo-fase2-introduccion': INTRODUCCION,
  };
  estado.proyecto = {
    id: 'p1',
    productCode: 'ARTICULO_SCIENTIFICOS',
    tema: null,
    carrera: null,
    universidad: null,
    autor: null,
    asesor: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    stages: Object.keys(estado.textos).map((skillCode) => ({ skillCode, estado: 'EN_CURSO', palabras: 10 })),
    ...cambios,
  };
}

async function textosDelWord() {
  const word = await projectService.armarWord('u1', 'ARTICULO_SCIENTIFICOS');
  const xml = new AdmZip(word.buffer).getEntry('word/document.xml').getData().toString('utf8');
  return { xml, textos: [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]) };
}

test('el artículo empírico sale como manuscrito: título arriba, sin portada de tesis ni índice', async () => {
  empezar();
  const { xml, textos } = await textosDelWord();
  assert.equal(textos[0], 'Dependencia de ChatGPT y pensamiento crítico en universitarios', 'el [TITULO] va arriba');
  assert.ok(!textos.includes('Tesis'));
  assert.ok(!textos.some((t) => t.startsWith('Autor: ')), 'sin «Autor:»');
  assert.ok(!textos.includes('Índice'), 'sin índice');
  assert.ok(!xml.includes('[TITULO]'), 'la marca no sale impresa');
});

test('«Introducción» sale una vez, y el subtítulo de verdad se queda', async () => {
  empezar();
  const { textos } = await textosDelWord();
  assert.equal(textos.filter((t) => t === 'Introducción').length, 1);
  assert.ok(textos.includes('Vacío y objetivo'));
  assert.ok(!textos.includes('Matriz de Estrategia') && !textos.includes('Enfoque'), 'la Matriz no entra');
});

test('si el proyecto tiene tema, el título es el tema', async () => {
  empezar({ tema: 'Título guardado en el proyecto' });
  const { textos } = await textosDelWord();
  assert.equal(textos[0], 'Título guardado en el proyecto');
});

test('verificar_citas no cuenta las fichas de trabajo, salvo que se pida una por su clave', async () => {
  empezar();
  estado.textos['articulo-fase1-matriz-de-estrategia'] += '\n| Muestra | Kock y Hadaya [AR0A1B2C3D] |';
  estado.textos['articulo-fase2-introduccion'] += '\n\nCrece la dependencia [ARFFFF0001].';
  const todo = await projectService.verificarCitas('u1', 'ARTICULO_SCIENTIFICOS');
  assert.deepEqual(todo.items.map((i) => i.capitulo), ['articulo-fase2-introduccion']);

  const matriz = await projectService.verificarCitas('u1', 'ARTICULO_SCIENTIFICOS', {
    capitulo: 'articulo-fase1-matriz-de-estrategia',
  });
  assert.deepEqual(matriz.items.map((i) => i.clave), ['AR0A1B2C3D']);
});

test('con las secciones de la revista guardadas, el Word usa su nombre', async () => {
  empezar({
    esquema: { capitulos: [{ titulo: 'Marco teórico e hipótesis', de: ['articulo-fase2-introduccion'] }] },
  });
  const { textos } = await textosDelWord();
  assert.ok(textos.includes('Marco teórico e hipótesis'));
  assert.ok(!textos.includes('Matriz de Estrategia'));
});

test('al guardar la Matriz no pide verificar sus citas; al guardar la Introducción, sí', async () => {
  empezar();
  const referencias = require('../src/modules/references/reference.service');
  const antes = referencias.porClaves;
  referencias.porClaves = async (claves) => claves.map((ref) => ({ ref, authors: 'Kock, N.', year: 2016, title: 'T' }));
  try {
    estado.textos['articulo-fase1-matriz-de-estrategia'] = '| Muestra | Kock [AR0A1B2C3D] |';
    estado.textos['articulo-fase2-introduccion'] = 'Crece la dependencia [AR0A1B2C3D].';
    const matriz = await projectService.controlAlGuardar('u1', 'ARTICULO_SCIENTIFICOS', 'articulo-fase1-matriz-de-estrategia');
    assert.ok(!matriz.some((a) => /no las ha verificado/.test(a)), matriz.join(' | '));
    const intro = await projectService.controlAlGuardar('u1', 'ARTICULO_SCIENTIFICOS', 'articulo-fase2-introduccion');
    assert.ok(intro.some((a) => /no las ha verificado/.test(a)));
  } finally {
    referencias.porClaves = antes;
  }
});
