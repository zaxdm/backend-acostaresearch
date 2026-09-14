'use strict';

/**
 * Consejos de la plataforma por el conector.
 *
 * Lo que se prueba: qué consejo toca en cada situación, que sale uno solo y por
 * orden de prioridad, que no se repite antes de tiempo, que al anotarlo no se
 * toca la fecha de trabajo de la tesis, y que sin proyecto no hay consejo. La
 * base y el disco se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const estado = {
  proyecto: null,
  fuentes: 0,
  zotero: null,
  fechaAnalisis: null,
  anotado: null,
};

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const CATALOGO = [
  { code: 'tema-y-delimitacion', displayName: '1 · Tema y delimitación' },
  { code: 'problema-y-objetivos', displayName: '2 · Capítulo I · Problema y objetivos' },
  { code: 'marco-teorico', displayName: '3 · Capítulo II · Marco teórico' },
  { code: 'metodologia', displayName: '4 · Capítulo III · Metodología' },
  { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' },
  { code: 'discusion', displayName: '8 · Capítulo V · Discusión' },
  { code: 'conclusiones', displayName: '9 · Capítulo VI · Conclusiones y resumen' },
  { code: 'humanizador-academico', displayName: 'Humanizador académico' },
  { code: 'bajar-similitud', displayName: 'Bajar similitud' },
];

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  anotarConsejos: async (id, consejos, updatedAt) => {
    estado.anotado = { id, consejos, updatedAt };
  },
});
sustituir('../src/modules/projects/project.storage', {
  fechaDeAnalisis: async () => estado.fechaAnalisis,
});
sustituir('../src/modules/skills/skill.service', { listCatalog: async () => CATALOGO });
sustituir('../src/modules/references/propias.repository', { contar: async () => estado.fuentes });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => estado.zotero });
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });

const { consejoPara, elegir } = require('../src/modules/projects/project.consejos');

const fase = (code) => CATALOGO.find((s) => s.code === code);
const FASES = CATALOGO.filter((s) => !['humanizador-academico', 'bajar-similitud'].includes(s.code));
const APOYOS = ['Humanizador académico', 'Bajar similitud'];
const AHORA = new Date('2026-09-14T12:00:00Z');

function empezar(cambios = {}) {
  Object.assign(
    estado,
    {
      proyecto: {
        id: 'p1',
        estiloCitas: null,
        plantillaAt: null,
        consejos: null,
        updatedAt: new Date('2026-09-10T00:00:00Z'),
        stages: [],
      },
      fuentes: 0,
      zotero: null,
      fechaAnalisis: null,
      anotado: null,
    },
    cambios,
  );
}

// ── Qué toca ───────────────────────────────────────────────────────────────

test('sin fuentes ni Zotero, al abrir el marco teórico: conectar fuentes', () => {
  assert.equal(elegir({ actual: fase('marco-teorico'), fases: FASES }), 'fuentes');
});

test('sin fuentes, pero en un capítulo que no cita (metodología): nada', () => {
  assert.equal(elegir({ actual: fase('metodologia'), fases: FASES }), null);
});

test('con Zotero conectado y sin colección: elegirla, en cualquier fase y antes que nada', () => {
  const zotero = { collectionName: null };
  assert.equal(elegir({ actual: fase('metodologia'), fases: FASES, zotero }), 'zotero-coleccion');
  assert.equal(
    elegir({ actual: fase('marco-teorico'), fases: FASES, zotero, palabras: 500 }),
    'zotero-coleccion',
  );
});

test('con Zotero y colección elegida no se le pide conectar fuentes aunque aún no haya llegado nada', () => {
  const zotero = { collectionName: 'Tesis' };
  assert.equal(elegir({ actual: fase('marco-teorico'), fases: FASES, zotero }), null);
});

test('análisis pendiente en resultados: la página de R', () => {
  assert.equal(
    elegir({ actual: fase('analisis-datos-rstudio'), fases: FASES, analisisPendiente: true }),
    'analisis',
  );
});

test('todas las fases terminadas: humanizador y Word; pero no si ya está abriendo el humanizador', () => {
  const base = { fases: FASES, apoyos: APOYOS, todasListas: true, palabras: 9000 };
  assert.equal(elegir(base), 'terminada');
  assert.notEqual(elegir({ ...base, actual: fase('humanizador-academico') }), 'terminada');
});

test('ya no se manda a subir el formato: el panel no tiene ese recuadro', () => {
  const fases = FASES;
  assert.notEqual(elegir({ actual: fase('discusion'), fases, palabras: 5000, estiloCitas: 'apa' }), 'plantilla');
});

test('con texto y sin norma elegida: la norma de citas', () => {
  assert.equal(elegir({ actual: fase('metodologia'), fases: FASES, palabras: 800 }), 'norma');
});

test('uno solo: el que más importa ahora', () => {
  assert.equal(
    elegir({ actual: fase('marco-teorico'), fases: FASES, palabras: 800 }),
    'fuentes',
    'sin fuentes no hay marco teórico; la norma puede esperar',
  );
});

test('no se repite antes de siete días; si el primero ya se dio, pasa al siguiente', () => {
  const base = { actual: fase('marco-teorico'), fases: FASES, palabras: 800, ahora: AHORA };
  const hace2 = new Date(AHORA.getTime() - 2 * 86400000).toISOString();
  const hace8 = new Date(AHORA.getTime() - 8 * 86400000).toISOString();

  assert.equal(elegir({ ...base, mostrados: { fuentes: hace2 } }), 'norma');
  // Detrás de la norma va el formato de la universidad: el perfil ya no tiene
  // recuadro, así que el consejo es lo que hace que alguien lo suba.
  assert.equal(elegir({ ...base, mostrados: { fuentes: hace2, norma: hace2 } }), 'formato');
  assert.equal(elegir({ ...base, mostrados: { fuentes: hace2, norma: hace2, formato: hace2 } }), null);
  assert.equal(elegir({ ...base, mostrados: { fuentes: hace8 } }), 'fuentes');
});

// ── De extremo a extremo, con la base sustituida ───────────────────────────

test('sin proyecto no hay consejo', async () => {
  empezar({ proyecto: null });
  assert.equal(await consejoPara({ userId: 'u1', productCode: 'METODO', ahora: AHORA }), null);
});

test('el consejo sale envuelto, se anota y no toca la fecha de trabajo de la tesis', async () => {
  empezar();
  const t = await consejoPara({
    userId: 'u1',
    productCode: 'METODO',
    capitulo: 'marco-teorico',
    ahora: AHORA,
  });

  assert.match(t, /^CONSEJO DE LA PLATAFORMA/);
  assert.match(t, /Tu Zotero/);
  assert.match(t, /al terminar este paso/);
  assert.deepEqual(estado.anotado.consejos, { fuentes: AHORA.toISOString() });
  assert.equal(estado.anotado.updatedAt.toISOString(), '2026-09-10T00:00:00.000Z');
});

test('en resultados con un análisis ya enviado, no se le manda a la página de R', async () => {
  empezar({ fechaAnalisis: new Date(), fuentes: 20 });
  estado.proyecto.estiloCitas = 'apa';
  const t = await consejoPara({
    userId: 'u1',
    productCode: 'METODO',
    capitulo: 'analisis-datos-rstudio',
    ahora: AHORA,
  });
  assert.equal(t, null);
});

test('desde mi_proyecto se toma la fase en curso', async () => {
  empezar({ fuentes: 0 });
  estado.proyecto.stages = [
    { skillCode: 'tema-y-delimitacion', estado: 'LISTO', palabras: 0 },
    { skillCode: 'marco-teorico', estado: 'EN_CURSO', palabras: 0 },
  ];
  const t = await consejoPara({ userId: 'u1', productCode: 'METODO', ahora: AHORA });
  assert.match(t, /fuentes propias/);
});

test('con texto y norma pero sin formato: preguntar por el formato y dar el enlace', () => {
  const base = { actual: fase('metodologia'), fases: FASES, palabras: 800, estiloCitas: 'apa' };
  assert.equal(elegir(base), 'formato');
  assert.notEqual(elegir({ ...base, plantillaAt: new Date() }), 'formato', 'con formato puesto, no');

  const { redactar } = require('../src/modules/projects/project.consejos');
  const texto = redactar('formato');
  assert.match(texto, /formato_de_la_universidad/);
  assert.doesNotMatch(texto, /perfil/);
});

test('la norma se pregunta en la conversación, no en el panel', () => {
  const { redactar } = require('../src/modules/projects/project.consejos');
  const texto = redactar('norma');
  assert.match(texto, /guardar_avance/);
  assert.doesNotMatch(texto, /perfil/);
});

