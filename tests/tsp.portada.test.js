'use strict';

/**
 * La portada del TSP dice qué es: «Trabajo de Suficiencia Profesional» debajo
 * del título (E2E del 7-nov-2026: con el formato por defecto no lo decía en
 * ninguna parte). La de tesis sigue igual.
 *
 * La base, el disco y el catálogo se sustituyen; el Word es el de verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const estado = { proyecto: null, textos: {}, producto: 'TSP_SUFICIENCIA_PROFESIONAL' };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  nombreDe: async () => 'Benicio Acosta Enríquez',
  listarDeUsuario: async () => (estado.proyecto ? [estado.proyecto] : []),
  productosConLicencia: async () => [estado.producto],
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
    { code: 'tsp-fase0-experiencia', displayName: '0 · Tu experiencia y la empresa' },
    { code: 'tsp-fase1-introduccion', displayName: '1 · Capítulo I · Introducción' },
    { code: 'tesis-fase1-introduccion', displayName: '1 · Capítulo I · Introducción' },
  ],
  findByCode: async () => null,
});

sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });
sustituir('../src/modules/mendeley/mendeley.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

function empezar(producto, capitulo) {
  estado.producto = producto;
  estado.textos = { [capitulo]: '## 1.1 Realidad problemática\n\nEl almacén perdía pedidos.' };
  estado.proyecto = {
    id: 'p1',
    productCode: producto,
    tema: 'Control de inventarios con clasificación ABC',
    carrera: 'Administración',
    universidad: 'Universidad Privada del Norte',
    autor: null,
    asesor: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    stages: [{ skillCode: capitulo, estado: 'EN_CURSO', palabras: 10 }],
  };
}

async function textosDelWord(producto) {
  const word = await projectService.armarWord('u1', producto);
  const xml = new AdmZip(word.buffer).getEntry('word/document.xml').getData().toString('utf8');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
}

test('la portada del TSP dice «Trabajo de Suficiencia Profesional» debajo del título', async () => {
  empezar('TSP_SUFICIENCIA_PROFESIONAL', 'tsp-fase1-introduccion');
  const textos = await textosDelWord('TSP_SUFICIENCIA_PROFESIONAL');
  const titulo = textos.indexOf('Control de inventarios con clasificación ABC');
  const modalidad = textos.indexOf('Trabajo de Suficiencia Profesional');
  assert.ok(titulo >= 0 && modalidad > titulo, `título en ${titulo}, modalidad en ${modalidad}`);
  assert.ok(modalidad < textos.findIndex((t) => t.startsWith('Autor: ')), 'antes del autor');
});

test('la portada de tesis no cambia', async () => {
  empezar('METODO_DE_TESIS', 'tesis-fase1-introduccion');
  const textos = await textosDelWord('METODO_DE_TESIS');
  assert.ok(textos.includes('Control de inventarios con clasificación ABC'));
  assert.ok(!textos.includes('Trabajo de Suficiencia Profesional'));
});
