'use strict';

/**
 * El Word del informe estudiantil.
 *
 * Lo que tiene que ser cierto:
 *
 *   · la portada es la de un informe: curso, integrantes con código, docente,
 *     ciclo y sección, lugar y fecha; sin asesor;
 *   · el resumen y la introducción, que se escriben al final, van delante;
 *   · esas secciones aparte solo existen en el informe: en una tesis se ignoran;
 *   · el archivo se llama «informe-…» si no hay tema.
 *
 * La portada de tesis y artículo la vigila `productos.word.instantanea`.
 * La base, el disco, el catálogo y las fichas se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const INFORME = 'INFORME_ESTUDIANTIL';
const TESIS = 'METODO_9_SKILLS';

const estado = { proyecto: null, textos: {} };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  nombreDe: async () => 'Cuenta Del Estudiante',
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/projects/project.storage', {
  leer: async (projectId, clave) => estado.textos[clave] ?? null,
  palabrasDe: (texto) => String(texto).split(/\s+/).filter(Boolean).length,
  leerPlantilla: async () => null,
  leerFichaDeDocumento: async () => null,
  fechaDeAnalisis: async () => null,
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async (productCode) =>
    productCode === INFORME
      ? [
          { code: 'informe-fase0-encargo', displayName: 'Fase 0 — El encargo' },
          { code: 'informe-fase2-desarrollo', displayName: 'Fase 2 — Desarrollo' },
        ]
      : [{ code: 'marco-teorico', displayName: '3 · Capítulo II · Marco teórico' }],
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');
const documento = require('../src/modules/projects/project.docx');

const xmlDe = (buffer) => new AdmZip(buffer).readAsText('word/document.xml');

/** El texto visible del documento, sin etiquetas: para buscar en orden. */
const visible = (xml) => xml.replace(/<[^>]+>/g, '');

function informe(cambios = {}) {
  estado.textos = {
    'informe-resumen': 'Este informe describe la informalidad laboral.',
    'informe-introduccion': 'La informalidad afecta a siete de cada diez trabajadores.',
    'informe-fase2-desarrollo': '## 1. Causas\n\nLas causas son varias.',
  };
  estado.proyecto = {
    id: 'p1',
    productCode: INFORME,
    tema: 'La informalidad laboral en Lima',
    carrera: 'Administración de Empresas',
    universidad: 'Tecsup',
    asesor: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    fichaInforme: {
      tipo: 'curso',
      curso: 'Economía General',
      docente: 'Mg. Rosa Díaz',
      integrantes: [
        { nombre: 'Ana Ruiz', codigo: 'U2023001' },
        { nombre: 'Luis Soto', codigo: 'U2023002' },
      ],
      cicloSeccion: 'IV ciclo, sección B',
      ciudad: 'Lima',
      fechaEntrega: '2026-10-01',
    },
    stages: [
      { skillCode: 'informe-fase2-desarrollo', estado: 'EN_CURSO', palabras: 20 },
      { skillCode: 'informe-introduccion', estado: 'EN_CURSO', palabras: 10 },
      { skillCode: 'informe-resumen', estado: 'EN_CURSO', palabras: 8 },
    ],
    ...cambios,
  };
}

test('la portada del informe lleva curso, integrantes, docente, ciclo, lugar y fecha', async () => {
  informe();
  const texto = visible(xmlDe((await projectService.armarWord('u1', INFORME)).buffer));

  for (const esperado of [
    'TECSUP',
    'Administración de Empresas',
    'Curso: Economía General',
    'La informalidad laboral en Lima',
    'Informe académico de curso',
    'Integrantes',
    'Ana Ruiz (U2023001)',
    'Luis Soto (U2023002)',
    'Docente: Mg. Rosa Díaz',
    'IV ciclo, sección B',
    'Lima, octubre de 2026',
  ]) {
    assert.ok(texto.includes(esperado), `falta «${esperado}»`);
  }
  assert.ok(!texto.includes('Asesor'), 'un informe no tiene asesor');
});

test('el resumen y la introducción van delante del desarrollo, en ese orden', async () => {
  informe();
  const texto = visible(xmlDe((await projectService.armarWord('u1', INFORME)).buffer));
  const donde = (frase) => texto.indexOf(frase);

  assert.ok(donde('Este informe describe') > 0);
  assert.ok(donde('Este informe describe') < donde('La informalidad afecta'));
  assert.ok(donde('La informalidad afecta') < donde('Las causas son varias'));
});

test('sin integrantes guardados firma la cuenta, y sin tema el archivo se llama informe', async () => {
  informe({ tema: null, fichaInforme: { curso: 'Economía General' } });
  const word = await projectService.armarWord('u1', INFORME);
  const texto = visible(xmlDe(word.buffer));

  assert.ok(texto.includes('Cuenta Del Estudiante'));
  assert.match(word.nombreArchivo, /^informe-\d{4}-\d{2}-\d{2}\.docx$/);
});

test('en una tesis, una clave de sección aparte no entra en el Word', async () => {
  estado.textos = {
    'marco-teorico': 'El marco teórico de verdad.',
    'informe-introduccion': 'Esto no debería salir en una tesis.',
  };
  estado.proyecto = {
    id: 'p2',
    productCode: TESIS,
    tema: null,
    carrera: null,
    universidad: null,
    asesor: 'Dra. Ana Ruiz',
    estiloCitas: null,
    plantillaAt: null,
    stages: [
      { skillCode: 'marco-teorico', estado: 'EN_CURSO', palabras: 5 },
      { skillCode: 'informe-introduccion', estado: 'EN_CURSO', palabras: 6 },
    ],
  };
  const word = await projectService.armarWord('u1', TESIS);
  const texto = visible(xmlDe(word.buffer));

  assert.ok(texto.includes('El marco teórico de verdad.'));
  assert.ok(!texto.includes('Esto no debería salir'));
  assert.ok(texto.includes('Asesor: Dra. Ana Ruiz'), 'la portada de tesis sigue siendo la de tesis');
  assert.match(word.nombreArchivo, /^tesis-/);
});

test('las secciones aparte se leen en el informe y no existen en una tesis', async () => {
  informe();
  const leido = await projectService.textoDeCapitulo('u1', INFORME, 'informe-introduccion');
  assert.equal(leido.vacio, false);
  assert.match(leido.texto, /siete de cada diez/);

  assert.equal(projectService.seccionAparte(TESIS, 'informe-introduccion'), null);
  assert.equal(await projectService.textoDeCapitulo('u1', TESIS, 'informe-introduccion'), null);
});

test('el panorama del informe dice las claves de sus secciones aparte', async () => {
  informe();
  const texto = await projectService.resumen('u1', INFORME);
  assert.match(texto, /Resumen \(informe-resumen\) · 8 palabras/);
  assert.match(texto, /Introducción \(informe-introduccion\) · 10 palabras/);
});

test('el nombre del archivo de una tesis sin tema no cambia', () => {
  assert.match(documento.nombreDeArchivo(null), /^tesis-/);
  assert.match(documento.nombreDeArchivo(null, 'informe'), /^informe-/);
});
