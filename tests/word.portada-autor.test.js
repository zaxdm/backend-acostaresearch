'use strict';

/**
 * Quién firma la portada del Word.
 *
 * Hasta el 17 de septiembre de 2026 la portada salía SIEMPRE con el nombre de
 * la cuenta. Casi siempre es el mismo —el tesista trabaja su propia tesis—,
 * pero no siempre: un asesor que acompaña a varios, o una cuenta abierta con
 * otro nombre, y el Word se descargaba firmado por quien no era. Se vio en un
 * capítulo de resultados ya entregado.
 *
 * Ahora el proyecto guarda su autor, y la cuenta es solo el respaldo. La base,
 * el disco, el catálogo y las fichas se sustituyen; el Word es el de verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const estado = { proyecto: null };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async (userId, productCode, cambios = {}) => {
    for (const [campo, valor] of Object.entries(cambios)) {
      if (valor !== undefined && valor !== null) estado.proyecto[campo] = valor;
    }
    return estado.proyecto;
  },
  // El nombre de la cuenta, que es lo que salía antes en la portada.
  nombreDe: async () => 'Benicio Acosta Enríquez',
  listarDeUsuario: async () => (estado.proyecto ? [estado.proyecto] : []),
  productosConLicencia: async () => ['METODO_9_SKILLS'],
  productosConVariasTesis: async () => [],
  nombresDeProducto: async () => new Map(),
  guardarEtapa: async () => ({}),
});

sustituir('../src/modules/projects/project.storage', {
  leerFichaDeDocumento: async () => null,
  leer: async () => 'El diseño fue no experimental.',
  leerPlantilla: async () => null,
});

sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [{ code: 'metodologia', displayName: '4 · Capítulo III · Metodología' }],
  findByCode: async () => null,
});

sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

function empezar(cambios = {}) {
  estado.proyecto = {
    id: 'p1',
    productCode: 'METODO_9_SKILLS',
    tema: 'Clima laboral y desempeño',
    carrera: 'Psicología',
    universidad: 'UNSAAC',
    autor: null,
    asesor: 'Dr. Juan Pérez',
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    stages: [{ skillCode: 'metodologia', estado: 'EN_CURSO', palabras: 6 }],
    ...cambios,
  };
}

/** El texto de cada <w:t> del documento, en orden. */
async function textosDelWord() {
  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');
  const xml = new AdmZip(word.buffer).getEntry('word/document.xml').getData().toString('utf8');
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);
}

test('sin autor guardado, la portada sigue saliendo con el nombre de la cuenta', async () => {
  empezar();
  assert.ok((await textosDelWord()).includes('Benicio Acosta Enríquez'));
});

test('con autor guardado, la portada es del tesista y no del titular de la cuenta', async () => {
  empezar({ autor: 'Ana María Quispe Flores' });
  const textos = await textosDelWord();

  assert.ok(textos.includes('Ana María Quispe Flores'));
  assert.ok(!textos.includes('Benicio Acosta Enríquez'), 'el nombre de la cuenta ya no aparece');
});

test('un autor en blanco no deja la portada sin nombre: vuelve al de la cuenta', async () => {
  empezar({ autor: '   ' });
  assert.ok((await textosDelWord()).includes('Benicio Acosta Enríquez'));
});

test('el autor se guarda desde el panel y desde la conversación', async () => {
  empezar();

  assert.equal(
    await projectService.cambiarAutor({
      userId: 'u1',
      productCode: 'METODO_9_SKILLS',
      autor: 'Ana María Quispe Flores',
    }),
    'Ana María Quispe Flores',
  );
  assert.ok((await textosDelWord()).includes('Ana María Quispe Flores'));
});

test('el panorama dice quién firma, y sin dato avisa de que será la cuenta', async () => {
  empezar();
  assert.match(await projectService.resumen('u1', 'METODO_9_SKILLS'), /Autor \(portada\): sin dato/);

  empezar({ autor: 'Ana María Quispe Flores' });
  const conAutor = await projectService.resumen('u1', 'METODO_9_SKILLS');
  assert.match(conAutor, /Autor \(portada\): Ana María Quispe Flores/);
  assert.doesNotMatch(conAutor, /sin dato/);
});
