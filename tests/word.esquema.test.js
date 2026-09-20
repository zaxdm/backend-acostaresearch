'use strict';

/**
 * La estructura de la facultad, de punta a punta: del conector al Word.
 *
 * Lo que se comprueba es lo que ve el tesista al abrir su documento: los
 * títulos con SU numeración, Resultados y Discusión en un solo capítulo, un
 * capítulo de Hipótesis que el método no tiene, y el índice con esas mismas
 * entradas. La base, el disco y el catálogo se sustituyen; el Word es el de
 * verdad.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const estado = { proyecto: null, textos: new Map(), clavesPedidas: [] };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const CATALOGO = [
  { code: 'problema-y-objetivos', displayName: '2 · Capítulo I · Problema y objetivos' },
  { code: 'metodologia', displayName: '4 · Capítulo III · Metodología' },
  { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' },
  { code: 'discusion', displayName: '8 · Capítulo V · Discusión' },
];

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async (userId, productCode, cambios = {}) => {
    for (const [campo, valor] of Object.entries(cambios)) {
      if (valor !== undefined && valor !== null) estado.proyecto[campo] = valor;
    }
    return estado.proyecto;
  },
  nombreDe: async () => 'Ana María Quispe Flores',
  listarDeUsuario: async () => (estado.proyecto ? [estado.proyecto] : []),
  productosConLicencia: async () => ['METODO_9_SKILLS'],
  productosConVariasTesis: async () => [],
  nombresDeProducto: async () => new Map(),
  guardarEtapa: async () => ({}),
});

sustituir('../src/modules/projects/project.storage', {
  leerFichaDeDocumento: async () => null,
  leer: async (_id, clave) => estado.textos.get(clave) ?? null,
  leerPlantilla: async () => null,
  palabrasDe: (texto) => String(texto ?? '').split(/\s+/).filter(Boolean).length,
});

sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => CATALOGO,
  findByCode: async (code) => CATALOGO.find((s) => s.code === code) ?? null,
  perteneceAlGrupo: () => true,
});

sustituir('../src/modules/references/reference.service', {
  porClaves: async (claves) => {
    estado.clavesPedidas = claves;
    return [];
  },
});
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

/** El de la UNSAAC: un III de Hipótesis, Metodología al IV, y V con las dos. */
const UNSAAC = [
  { titulo: 'CAPÍTULO I: PROBLEMA', de: ['problema-y-objetivos'] },
  { titulo: 'CAPÍTULO III: HIPÓTESIS', de: [] },
  { titulo: 'CAPÍTULO IV: METODOLOGÍA', de: ['metodologia'] },
  { titulo: 'CAPÍTULO V: RESULTADOS Y DISCUSIÓN', de: ['analisis-datos-rstudio', 'discusion'] },
];

function empezar(cambios = {}) {
  estado.textos = new Map([
    ['problema-y-objetivos', 'El problema es la deserción.'],
    ['metodologia', 'El diseño fue no experimental.'],
    ['analisis-datos-rstudio', 'La media fue de 14,2 puntos.'],
    ['discusion', 'Coincide con lo hallado por García.'],
  ]);
  estado.proyecto = {
    id: 'p1',
    productCode: 'METODO_9_SKILLS',
    tema: 'Clima laboral y desempeño',
    carrera: 'Psicología',
    universidad: 'UNSAAC',
    autor: null,
    esquema: null,
    asesor: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    stages: [...estado.textos.keys()].map((skillCode) => ({
      skillCode,
      estado: 'EN_CURSO',
      palabras: 5,
    })),
    ...cambios,
  };
}

const guardar = (capitulos) =>
  projectService.guardarEsquema({ userId: 'u1', productCode: 'METODO_9_SKILLS', capitulos });

/** Los títulos de nivel 1 del Word, en orden: los capítulos tal como se ven. */
async function titulosDelWord() {
  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');
  const xml = new AdmZip(word.buffer).getEntry('word/document.xml').getData().toString('utf8');
  return [...xml.matchAll(/<w:pStyle w:val="Heading1"\/>[\s\S]*?<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(
    (m) => m[1],
  );
}

test('sin estructura propia, el Word sale con los capítulos del método', async () => {
  empezar();
  assert.deepEqual(await titulosDelWord(), [
    'Capítulo I: Problema y objetivos',
    'Capítulo III: Metodología',
    'Capítulo IV: Resultados',
    'Capítulo V: Discusión',
  ]);
});

test('con la estructura de la UNSAAC, el Word sale con SU numeración', async () => {
  empezar();
  await guardar(UNSAAC);

  // El de Hipótesis todavía no tiene texto, así que no sale: un capítulo vacío
  // haría creer que el documento está más avanzado de lo que está.
  assert.deepEqual(await titulosDelWord(), [
    'CAPÍTULO I: PROBLEMA',
    'CAPÍTULO IV: METODOLOGÍA',
    'CAPÍTULO V: RESULTADOS Y DISCUSIÓN',
  ]);
});

test('Resultados y Discusión salen juntos en un solo capítulo, con los dos textos', async () => {
  empezar();
  await guardar(UNSAAC);

  const word = await projectService.armarWord('u1', 'METODO_9_SKILLS');
  const xml = new AdmZip(word.buffer).getEntry('word/document.xml').getData().toString('utf8');
  const textos = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);

  const quinto = textos.indexOf('CAPÍTULO V: RESULTADOS Y DISCUSIÓN');
  const resultado = textos.findIndex((t) => t.includes('La media fue'));
  const discusion = textos.findIndex((t) => t.includes('Coincide con lo hallado'));

  assert.ok(quinto !== -1 && quinto < resultado && resultado < discusion, textos.join(' | '));
  // Y no queda ningún título de Discusión suelto detrás.
  assert.ok(!(await titulosDelWord()).some((t) => /Discusión$/.test(t)));
});

test('el capítulo que el método no tiene se escribe y sale en su sitio', async () => {
  empezar();
  const { esquema } = await guardar(UNSAAC);
  const clave = esquema.capitulos[1].clave;

  // Se guarda como cualquier otro capítulo, con la clave que puso el servidor.
  estado.textos.set(clave, 'Hi: existe relación entre el clima y el desempeño.');
  estado.proyecto.stages.push({ skillCode: clave, estado: 'EN_CURSO', palabras: 9 });

  assert.deepEqual(await titulosDelWord(), [
    'CAPÍTULO I: PROBLEMA',
    'CAPÍTULO III: HIPÓTESIS',
    'CAPÍTULO IV: METODOLOGÍA',
    'CAPÍTULO V: RESULTADOS Y DISCUSIÓN',
  ]);

  // Y se puede leer con su clave, que es lo que necesita el asistente para
  // seguir escribiéndolo en otra conversación.
  const leido = await projectService.textoDeCapitulo('u1', 'METODO_9_SKILLS', clave);
  assert.equal(leido.skill.displayName, 'CAPÍTULO III: HIPÓTESIS');
  assert.match(leido.texto, /existe relación/);
});

test('una fase con texto que la estructura no nombra sale igual, al final y avisando', async () => {
  empezar();
  const { sobrantes } = await guardar([
    { titulo: 'CAPÍTULO ÚNICO', de: ['metodologia'] },
  ]);

  assert.deepEqual(sobrantes.map((s) => s.code), [
    'problema-y-objetivos',
    'analisis-datos-rstudio',
    'discusion',
  ]);
  const titulos = await titulosDelWord();
  assert.equal(titulos[0], 'CAPÍTULO ÚNICO');
  assert.equal(titulos.length, 4, 'las tres fases sueltas siguen en el Word');
});

test('quitar la estructura devuelve el Word al método, sin tocar el texto', async () => {
  empezar();
  await guardar(UNSAAC);
  assert.equal(
    await projectService.quitarEsquema({ userId: 'u1', productCode: 'METODO_9_SKILLS' }),
    true,
  );

  assert.deepEqual(await titulosDelWord(), [
    'Capítulo I: Problema y objetivos',
    'Capítulo III: Metodología',
    'Capítulo IV: Resultados',
    'Capítulo V: Discusión',
  ]);
});

test('las citas de un capítulo propio llegan al .bib y al repaso, no solo al Word', async () => {
  // Es el hueco fácil de dejar: lo que recorre lo escrito iba por el catálogo,
  // y un capítulo propio no está en el catálogo. La bibliografía le habría
  // salido con fuentes de menos sin que nadie supiera por qué.
  empezar();
  const { esquema } = await guardar(UNSAAC);
  const clave = esquema.capitulos[1].clave;

  estado.textos.set(clave, 'Hi: hay relación [AR99999999].');
  estado.proyecto.stages.push({ skillCode: clave, estado: 'EN_CURSO', palabras: 5 });

  estado.clavesPedidas = [];
  await projectService.armarBibtex('u1', 'METODO_9_SKILLS');
  assert.ok(estado.clavesPedidas.includes('AR99999999'), estado.clavesPedidas.join(' | '));
});

test('el asistente lee la estructura en el panorama, con las claves de los capítulos propios', async () => {
  empezar();
  await guardar(UNSAAC);

  const memoria = await projectService.contexto('u1', 'METODO_9_SKILLS');
  assert.match(memoria, /ESTRUCTURA DE CAPÍTULOS DE SU FACULTAD/);
  assert.match(memoria, /CAPÍTULO V: RESULTADOS Y DISCUSIÓN/);
  assert.match(memoria, /clave: propio-capitulo-iii-hipotesis/);
});
