'use strict';

/**
 * El avance que se sube desde el panel: su Word repartido entre las fases.
 *
 * Lo que importa: que cada capítulo caiga en su fase con cualquiera de las
 * formas de titularlo que se ven en las tesis reales, que la portada y las
 * referencias no se cuelen en ningún capítulo, y que no pise un capítulo más
 * largo escrito con Claude.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function sustituir(ruta, exports) {
  const id = require.resolve(path.join(__dirname, ruta));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const TESIS = [
  'tema-y-delimitacion',
  'problema-y-objetivos',
  'marco-teorico',
  'metodologia',
  'instrumento-investigacion',
  'recoleccion-datos',
  'analisis-datos-rstudio',
  'discusion',
  'conclusiones-abstract',
].map((code) => ({ code, displayName: code }));

const ARTICULO = [
  'articulo-fase2-introduccion',
  'articulo-fase3-revision-literatura',
  'articulo-fase4-metodos',
  'articulo-fase5-resultados',
  'articulo-fase6-discusion',
  'articulo-fase7-conclusiones-abstract',
].map((code) => ({ code, displayName: code }));

const REVISION = [
  'revision-fase2-introduccion',
  'revision-fase4-metodos',
  'revision-fase5-resultados',
  'revision-fase6-discusion',
  'revision-fase7-conclusiones-abstract',
].map((code) => ({ code, displayName: code }));

const p = (texto, extra = {}) => ({ texto, nivel: null, enTabla: false, referencias: false, ...extra });

const { repartir } = require('../src/modules/projects/project.avance');

test('reparte por «Título 1», junta «CAPÍTULO II» con su nombre y deja fuera portada y referencias', () => {
  const { porFase, sinUbicar } = repartir(
    [
      p('UNIVERSIDAD NACIONAL'),
      p('Tesis para optar el título'),
      p('CAPÍTULO I', { nivel: 1 }),
      p('PLANTEAMIENTO DEL PROBLEMA', { nivel: 1 }),
      p('1.1 Realidad problemática', { nivel: 2 }),
      p('La deserción crece en el país.'),
      p('CAPÍTULO II'),
      p('MARCO TEÓRICO'),
      p('Los antecedentes muestran que…'),
      p('celda', { enTabla: true }),
      p('III. METODOLOGÍA'),
      p('El enfoque es cuantitativo.'),
      p('REFERENCIAS', { nivel: 1 }),
      p('Tinto, V. (1975).', { referencias: true }),
    ],
    { catalogo: TESIS, tipo: 'tesis' },
  );

  assert.deepEqual([...porFase.keys()], ['problema-y-objetivos', 'marco-teorico', 'metodologia']);
  assert.equal(porFase.get('problema-y-objetivos'), '## 1.1 Realidad problemática\n\nLa deserción crece en el país.');
  assert.equal(porFase.get('marco-teorico'), 'Los antecedentes muestran que…');
  assert.equal(sinUbicar, 7);
});

test('en la tesis, un «Capítulo IV» sin nombre va a resultados; un párrafo normal no parte nada', () => {
  const { porFase } = repartir(
    [
      p('Capítulo IV', { nivel: 1 }),
      p('Objetivos alcanzados en el estudio según la prueba aplicada a la muestra de estudiantes.'),
      p('Resultados y discusión', { nivel: 1 }),
      p('La correlación fue positiva.'),
    ],
    { catalogo: TESIS, tipo: 'tesis' },
  );
  assert.deepEqual([...porFase.keys()], ['analisis-datos-rstudio']);
  assert.match(porFase.get('analisis-datos-rstudio'), /Objetivos alcanzados[\s\S]*correlación/);
});

test('el artículo usa sus propias fases', () => {
  const { porFase } = repartir(
    [
      p('Resumen', { nivel: 1 }),
      p('Este estudio…'),
      p('Introducción', { nivel: 1 }),
      p('Texto de la introducción.'),
      p('Método', { nivel: 1 }),
      p('Participantes.'),
      p('Discusión', { nivel: 1 }),
      p('Se confirma.'),
    ],
    { catalogo: ARTICULO, tipo: 'articulo' },
  );
  assert.deepEqual([...porFase.keys()], [
    'articulo-fase2-introduccion',
    'articulo-fase4-metodos',
    'articulo-fase6-discusion',
  ]);
});

test('el artículo de revisión también: introducción, método y resultados van a sus fases', () => {
  const { porFase, sinUbicar } = repartir(
    [
      p('Introducción', { nivel: 1 }),
      p('Texto de la introducción.'),
      p('Metodología', { nivel: 1 }),
      p('Criterios de búsqueda.'),
      p('Resultados', { nivel: 1 }),
      p('Se incluyeron 40 estudios.'),
      p('Discusión', { nivel: 1 }),
      p('Se confirma.'),
      p('Conclusiones', { nivel: 1 }),
      p('Cierre.'),
    ],
    { catalogo: REVISION, tipo: 'articulo' },
  );
  assert.deepEqual([...porFase.keys()], [
    'revision-fase2-introduccion',
    'revision-fase4-metodos',
    'revision-fase5-resultados',
    'revision-fase6-discusion',
    'revision-fase7-conclusiones-abstract',
  ]);
  assert.equal(sinUbicar, 0);
});

test('el esquema de su facultad manda sobre los nombres de siempre', () => {
  const { porFase } = repartir(
    [p('Capítulo V: Resultados y discusión', { nivel: 1 }), p('Texto.')],
    {
      catalogo: TESIS,
      tipo: 'tesis',
      esquema: [{ titulo: 'Capítulo V: Resultados y discusión', de: ['discusion', 'analisis-datos-rstudio'] }],
    },
  );
  assert.deepEqual([...porFase.keys()], ['discusion']);
});

const INFORME = [
  'informe-resumen',
  'informe-introduccion',
  'informe-fase0-encargo',
  'informe-fase1-fuentes',
  'informe-fase2-desarrollo',
  'informe-fase3-analisis-y-resultados',
  'informe-fase4-cierre',
].map((code) => ({ code, displayName: code }));

test('el informe: resumen e introducción a sus secciones, y los apartados del docente al Desarrollo con su título', () => {
  const { porFase } = repartir(
    [
      p('INFORME DEL CASO PRÁCTICO'),
      p('Contenido', { nivel: 1 }),
      p('1. Introducción ........ 3'),
      p('Resumen ejecutivo', { nivel: 1 }),
      p('El informe propone…'),
      p('1. Introducción', { nivel: 1 }),
      p('NewTech SAC lanzará un módulo.'),
      p('2. Análisis de la situación actual', { nivel: 1 }),
      p('2.1 Incidentes previos', { nivel: 2 }),
      p('Hubo tres caídas.'),
      p('5. CAB y ECAB', { nivel: 1 }),
      p('El comité evalúa.'),
      p('10. Conclusiones', { nivel: 1 }),
      p('El proceso reduce el riesgo.'),
      p('Referencias', { nivel: 1 }),
      p('Cabinet Office. (2011).', { referencias: true }),
    ],
    { catalogo: INFORME, tipo: 'informe' },
  );

  assert.deepEqual([...porFase.keys()], [
    'informe-resumen',
    'informe-introduccion',
    'informe-fase2-desarrollo',
    'informe-fase4-cierre',
  ]);
  assert.equal(porFase.get('informe-introduccion'), 'NewTech SAC lanzará un módulo.');
  assert.equal(
    porFase.get('informe-fase2-desarrollo'),
    '## 2. Análisis de la situación actual\n\n### 2.1 Incidentes previos\n\nHubo tres caídas.\n\n' +
      '## 5. CAB y ECAB\n\nEl comité evalúa.',
  );
  assert.equal(porFase.get('informe-fase4-cierre'), 'El proceso reduce el riesgo.');
});

test('fuera del informe, un «Título 1» que no se reconoce sigue cortando sin ir a ninguna fase', () => {
  const { porFase } = repartir(
    [p('Marco teórico', { nivel: 1 }), p('Bases.'), p('Situación actual', { nivel: 1 }), p('Suelto.')],
    { catalogo: TESIS, tipo: 'tesis' },
  );
  assert.deepEqual([...porFase.entries()], [['marco-teorico', 'Bases.']]);
});

// ── El servicio ──────────────────────────────────────────────────────────

const AdmZip = require('adm-zip');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function docx(parrafos) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  const cuerpo = parrafos.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="${W}"><w:body>${cuerpo}<w:sectPr/></w:body></w:document>`));
  return zip.toBuffer();
}

let proyecto = null;
const etapas = [];
const textos = new Map();
let ficha = null;

sustituir('../src/modules/projects/project.repository', {
  productosConLicencia: async () => ['METODO', 'INFORME_PRUEBA'],
  buscar: async () => proyecto,
  asegurar: async () => proyecto,
  guardarEtapa: async (id, code, datos) => etapas.push({ code, ...datos }),
});
// El catálogo del informe no trae el resumen ni la introducción: los añade el servicio.
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async (code) => (code.startsWith('INFORME') ? INFORME.filter((s) => !/resumen|introduccion/.test(s.code)) : TESIS),
});
let voz = null;
sustituir('../src/modules/projects/project.storage', {
  palabrasDe: (t) => t.replace(/^#+\s+/gm, '').trim().split(/\s+/).length,
  guardar: async (id, code, texto) => {
    textos.set(code, texto);
    return { palabras: texto.trim().split(/\s+/).length };
  },
  borrar: async (id, code) => {
    textos.delete(code);
  },
  guardarFichaDeAvance: async (id, f) => {
    ficha = f;
  },
  leerFichaDeAvance: async () => ficha,
  borrarFichaDeAvance: async () => true,
  leerVoz: async () => voz,
  guardarVoz: async (id, v) => {
    voz = v;
  },
});

const servicio = require('../src/modules/projects/avance.service');

test('guarda cada capítulo en su fase, en curso, y no pisa uno más largo ni cierra uno terminado', async () => {
  proyecto = {
    id: 'p1',
    productCode: 'METODO',
    esquema: null,
    stages: [
      { skillCode: 'marco-teorico', palabras: 5000, estado: 'EN_CURSO' },
      { skillCode: 'metodologia', palabras: 1, estado: 'LISTO' },
    ],
  };

  const hecho = await servicio.subir({
    userId: 'u1',
    productCode: 'METODO',
    nombre: 'mi-tesis.docx',
    buffer: docx([
      'CAPÍTULO I: PLANTEAMIENTO DEL PROBLEMA',
      'La deserción universitaria crece.',
      'CAPÍTULO II: MARCO TEÓRICO',
      'Breve.',
      'CAPÍTULO III: METODOLOGÍA',
      'Enfoque cuantitativo y diseño correlacional.',
    ]),
  });

  assert.deepEqual(
    hecho.fases.map((f) => [f.code, f.conservada]),
    [
      ['problema-y-objetivos', false],
      ['marco-teorico', true],
      ['metodologia', false],
    ],
  );
  assert.equal(textos.has('marco-teorico'), false);
  assert.deepEqual(
    etapas.map((e) => [e.code, e.estado]),
    [
      ['problema-y-objetivos', 'EN_CURSO'],
      ['metodologia', undefined],
    ],
  );
  assert.match(servicio.mensajeDeSubida(hecho), /Se conservó lo que ya tenías con Claude en «marco-teorico»/);
  assert.equal(ficha.nombre, 'mi-tesis.docx');
});

test('sin ningún capítulo reconocible no guarda nada y explica cómo titularlos', async () => {
  proyecto = { id: 'p1', productCode: 'METODO', esquema: null, stages: [] };
  etapas.length = 0;
  await assert.rejects(
    servicio.subir({ userId: 'u1', productCode: 'METODO', buffer: docx(['Solo un párrafo sin títulos.']) }),
    servicio.AvanceSinCapitulos,
  );
  assert.equal(etapas.length, 0);
});

test('en el informe guarda la introducción en su sección aparte, con su nombre', async () => {
  proyecto = { id: 'p2', productCode: 'INFORME_PRUEBA', esquema: null, stages: [] };
  etapas.length = 0;
  textos.clear();

  const hecho = await servicio.subir({
    userId: 'u1',
    productCode: 'INFORME_PRUEBA',
    buffer: docx(['INTRODUCCIÓN', 'NewTech SAC lanzará un módulo de IA.', 'CONCLUSIONES', 'El proceso reduce el riesgo.']),
  });

  assert.deepEqual(
    hecho.fases.map((f) => [f.code, f.displayName]),
    [
      ['informe-introduccion', 'Introducción'],
      ['informe-fase4-cierre', 'informe-fase4-cierre'],
    ],
  );
  assert.equal(textos.get('informe-introduccion'), 'NewTech SAC lanzará un módulo de IA.');
  assert.match(servicio.mensajeDeFasesDesdeElDocumento(hecho), /Además pasó a tus fases: «Introducción», «informe-fase4-cierre»/);
});

test('desde el enlace del chat, un Word sin capítulos no estropea la subida: no pasa nada a las fases', async () => {
  proyecto = { id: 'p1', productCode: 'METODO', esquema: null, stages: [] };
  etapas.length = 0;
  const hecho = await servicio.tambienComoAvance({ userId: 'u1', productCode: 'METODO', buffer: docx(['Solo un párrafo.']) });
  assert.equal(hecho, null);
  assert.equal(etapas.length, 0);
  assert.equal(servicio.mensajeDeFasesDesdeElDocumento(hecho), '');
});

test('reemplazar: el archivo nuevo pisa aunque sea más corto y vacía lo que no trae (28-oct)', async () => {
  proyecto = {
    id: 'p1',
    productCode: 'METODO',
    esquema: null,
    stages: [
      { skillCode: 'marco-teorico', palabras: 5000, estado: 'EN_CURSO' },
      { skillCode: 'metodologia', palabras: 800, estado: 'EN_CURSO' },
      { skillCode: 'discusion', palabras: 600, estado: 'LISTO' },
      { skillCode: 'tema-y-delimitacion', palabras: 0, estado: 'EN_CURSO' },
    ],
  };
  etapas.length = 0;
  textos.clear();
  textos.set('metodologia', 'texto viejo');
  textos.set('discusion', 'texto viejo');

  const hecho = await servicio.subir({
    userId: 'u1',
    productCode: 'METODO',
    reemplazar: true,
    buffer: docx(['CAPÍTULO II: MARCO TEÓRICO', 'Breve.']),
  });

  // Más corto, pero se guarda igual.
  assert.deepEqual(hecho.fases.map((f) => [f.code, f.conservada]), [['marco-teorico', false]]);
  assert.equal(textos.get('marco-teorico'), 'Breve.');
  // Lo que no trae se vacía; la terminada sigue terminada; la que no tenía texto no se toca.
  assert.equal(textos.has('metodologia'), false);
  assert.equal(textos.has('discusion'), false);
  assert.deepEqual(hecho.vaciadas.map((f) => f.code), ['metodologia', 'discusion']);
  const deFase = (code) => etapas.find((e) => e.code === code);
  assert.equal(deFase('metodologia').estado, 'PENDIENTE');
  assert.equal(deFase('discusion').estado, undefined);
  assert.equal(deFase('tema-y-delimitacion'), undefined);
  assert.match(servicio.mensajeDeSubida(hecho), /quedaron vacías «metodologia», «discusion»/);
});

test('reemplazar un capítulo: todo el Word va a esa fase, sin su título y aunque sea más corto (28-oct)', async () => {
  proyecto = {
    id: 'p1',
    productCode: 'METODO',
    esquema: null,
    stages: [{ skillCode: 'metodologia', palabras: 5000, estado: 'LISTO' }],
  };
  etapas.length = 0;
  textos.clear();

  const hecho = await servicio.reemplazarCapitulo({
    userId: 'u1',
    productCode: 'METODO',
    capitulo: 'metodologia',
    buffer: docx(['CAPÍTULO III', 'METODOLOGÍA', 'Enfoque cuantitativo.', 'Diseño correlacional.']),
  });

  assert.equal(hecho.nombre, 'metodologia');
  assert.equal(textos.get('metodologia'), 'Enfoque cuantitativo.\n\nDiseño correlacional.');
  // Terminada sigue terminada.
  assert.deepEqual(etapas.map((e) => [e.code, e.estado]), [['metodologia', undefined]]);
});

test('reemplazar un capítulo rechaza claves ajenas sin escribir nada', async () => {
  proyecto = { id: 'p1', productCode: 'METODO', esquema: null, stages: [] };
  etapas.length = 0;
  textos.clear();
  const hecho = await servicio.reemplazarCapitulo({
    userId: 'u1', productCode: 'METODO', capitulo: 'otra-cosa', buffer: docx(['Texto.']),
  });
  assert.equal(hecho.error, 'no-es-fase');
  assert.equal(etapas.length, 0);
  assert.equal(textos.size, 0);
});

test('quitar un capítulo lo vacía y lo deja sin empezar; uno terminado sigue terminado', async () => {
  proyecto = {
    id: 'p1',
    productCode: 'METODO',
    esquema: null,
    stages: [
      { skillCode: 'analisis-datos-rstudio', palabras: 4, estado: 'EN_CURSO' },
      { skillCode: 'discusion', palabras: 900, estado: 'LISTO' },
    ],
  };
  etapas.length = 0;
  textos.clear();
  textos.set('analisis-datos-rstudio', 'RESULTADOS de la tesis');

  await servicio.quitarCapitulo({ userId: 'u1', productCode: 'METODO', capitulo: 'analisis-datos-rstudio' });
  await servicio.quitarCapitulo({ userId: 'u1', productCode: 'METODO', capitulo: 'discusion' });

  assert.equal(textos.has('analisis-datos-rstudio'), false);
  assert.deepEqual(
    etapas.map((e) => [e.code, e.estado, e.palabras]),
    [
      ['analisis-datos-rstudio', 'PENDIENTE', 0],
      ['discusion', undefined, 0],
    ],
  );
});
