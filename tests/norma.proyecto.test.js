'use strict';

/**
 * La norma de citas del proyecto, de punta a punta en el servicio.
 *
 * Que el Word salga en la norma elegida, con campos de Zotero solo si lo
 * conectó, y que si la norma no se puede aplicar salga igual en APA: nadie se
 * puede quedar sin su documento. La base, el disco, el catálogo, las fichas y la
 * cuenta de Zotero se sustituyen; el motor de citas y el Word son los de verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const WARSHAW = {
  ref: 'AR11111111',
  itemType: 'journalArticle',
  title: 'Disentangling behavioral intention and behavioral expectation',
  authors: 'Warshaw, P. R.; Davis, F. D.',
  year: 1985,
  source: 'Journal of Experimental Social Psychology',
  volume: '21',
  issue: '3',
  pages: '213-228',
  ownerUserId: 'u1',
  sourceRef: 'zotero:users/11174139:GUMS2P7U',
  origin: 'ZOTERO',
};

const BRAUN = {
  ref: 'AR22222222',
  itemType: 'journalArticle',
  title: 'Using thematic analysis in psychology',
  authors: 'Braun, V.; Clarke, V.',
  year: 2006,
  source: 'Qualitative Research in Psychology',
  volume: '3',
  issue: '2',
  pages: '77-101',
  ownerUserId: null,
};

const estado = { proyecto: null, cuenta: null, cslRompe: false };

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
  nombreDe: async () => 'Alguien',
  listarDeUsuario: async () => (estado.proyecto ? [estado.proyecto] : []),
  nombresDeProducto: async () => new Map(),
  guardarEtapa: async () => ({}),
});

sustituir('../src/modules/projects/project.storage', {
  leer: async () => 'Uno [AR11111111].\n\n[AR22222222:n] proponen seis fases.',
  leerPlantilla: async () => null,
});

sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [{ code: 'marco-teorico', displayName: '3 · Capítulo II · Marco teórico' }],
  findByCode: async () => null,
});

sustituir('../src/modules/references/reference.service', {
  porClaves: async () => [WARSHAW, BRAUN],
});

sustituir('../src/modules/zotero/biblioteca.repository', {
  deUsuario: async () => estado.cuenta,
});

// El motor de verdad, con una puerta para hacerlo fallar a propósito.
const cslReal = require('../src/modules/projects/project.csl');
sustituir('../src/modules/projects/project.csl', {
  ...cslReal,
  renderizar: (...argumentos) => {
    if (estado.cslRompe) throw new Error('una ficha que citeproc no sabe leer');
    return cslReal.renderizar(...argumentos);
  },
});

const projectService = require('../src/modules/projects/project.service');
const { guardarAvanceSchema } = require('../src/modules/projects/project.schema');

function empezar(cambios = {}) {
  estado.cuenta = null;
  estado.cslRompe = false;
  estado.proyecto = {
    id: 'p1',
    productCode: 'METODO_9_SKILLS',
    tema: 'Un tema',
    carrera: null,
    universidad: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    stages: [{ skillCode: 'marco-teorico', estado: 'EN_CURSO', palabras: 40 }],
    ...cambios,
  };
}

const xmlDe = (buffer, parte = 'word/document.xml') => {
  const entrada = new AdmZip(buffer).getEntry(parte);
  return entrada ? entrada.getData().toString('utf8') : '';
};

// ── Lo que acepta el conector ───────────────────────────────────────────────

test('guardar_avance acepta una de las quince normas y rechaza una inventada', () => {
  assert.equal(guardarAvanceSchema.safeParse({ estiloCitas: 'ieee', idiomaCitas: 'es-MX' }).success, true);

  const inventada = guardarAvanceSchema.safeParse({ estiloCitas: 'apa-6' });
  assert.equal(inventada.success, false);
  assert.match(inventada.error.issues[0].message, /nlm-citation-sequence/, 'dice cuáles valen');
});

// ── El Word ─────────────────────────────────────────────────────────────────

test('el Word sale en la norma del proyecto', async () => {
  empezar({ estiloCitas: 'ieee' });
  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');
  const doc = xmlDe(word.buffer);

  assert.equal(word.norma, 'ieee');
  assert.ok(doc.includes('[1]'));
  assert.ok(doc.includes('Braun y Clarke'));
  assert.ok(!doc.includes('ZOTERO'), 'sin Zotero conectado, sin campos');
});

test('sin norma elegida sale en APA, con el motor de Zotero', async () => {
  empezar();
  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');

  assert.equal(word.norma, 'apa');
  assert.ok(xmlDe(word.buffer).includes('Warshaw &amp; Davis, 1985'));
});

test('con Zotero conectado, las citas van en campos y la de su Zotero apunta a su ítem', async () => {
  empezar({ estiloCitas: 'ieee' });
  estado.cuenta = { zoteroUserId: '11174139' };

  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');
  const doc = xmlDe(word.buffer);

  assert.ok(doc.includes('ADDIN ZOTERO_ITEM CSL_CITATION'));
  assert.ok(doc.includes('http://zotero.org/users/11174139/items/GUMS2P7U'));
  assert.ok(doc.includes('https://acostaresearch.com/fuentes/AR22222222'));
  assert.ok(xmlDe(word.buffer, 'docProps/custom.xml').includes('styles/ieee'));
});

test('si la norma no se puede aplicar, el Word sale igual en el APA de respaldo', async () => {
  empezar({ estiloCitas: 'chicago-notes-bibliography' });
  estado.cslRompe = true;

  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');
  const doc = xmlDe(word.buffer);

  assert.equal(word.norma, 'apa');
  assert.ok(doc.includes('(Warshaw y Davis, 1985)'));
  assert.ok(doc.includes('Braun y Clarke (2006)'), 'la narrativa también se entiende en el respaldo');
});

// ── El panel y el conector ──────────────────────────────────────────────────

test('el panel recibe la norma del proyecto, y si no se eligió, la de por defecto', async () => {
  empezar({ estiloCitas: 'nature' });
  const [conNorma] = await projectService.deUsuario('u1');
  assert.deepEqual(
    { estilo: conNorma.norma.estilo, familia: conNorma.norma.familia, elegida: conNorma.norma.elegida },
    { estilo: 'nature', familia: 'numerica', elegida: true },
  );

  empezar();
  const [sinNorma] = await projectService.deUsuario('u1');
  assert.equal(sinNorma.norma.estilo, 'apa');
  assert.equal(sinNorma.norma.elegida, false);
});

test('cambiar la norma solo toca un proyecto que existe, y conserva el idioma', async () => {
  empezar({ idiomaCitas: 'es-MX' });
  const norma = await projectService.cambiarNorma({ userId: 'u1', productCode: 'METODO_9_SKILLS', estiloCitas: 'mhra-notes' });

  assert.equal(norma.estilo, 'mhra-notes');
  assert.equal(norma.familia, 'notas');
  assert.equal(norma.idioma, 'es-MX');

  estado.proyecto = null;
  assert.equal(
    await projectService.cambiarNorma({ userId: 'u1', productCode: 'METODO_9_SKILLS', estiloCitas: 'ieee' }),
    null,
  );
});

test('el enlace del Word existe solo si hay algo escrito', async () => {
  empezar();
  const enlace = await projectService.enlaceDelWord('u1', 'METODO_9_SKILLS');
  assert.match(enlace.url, /\/proyectos\/descarga\/[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(enlace.minutos, 30);

  empezar({ stages: [{ skillCode: 'marco-teorico', estado: 'PENDIENTE', palabras: 0 }] });
  assert.equal(await projectService.enlaceDelWord('u1', 'METODO_9_SKILLS'), null);
});
