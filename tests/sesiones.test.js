'use strict';

/**
 * Sesiones de aprendizaje para educación superior (códigos SESIONES*).
 *
 * Lo que tiene que ser cierto:
 *
 *   · su perfil es el de un docente, no el de un tesista;
 *   · el conector solo le registra las herramientas que usan sus skills, y la
 *     tesis sigue con las suyas;
 *   · guardar y leer UNA sesión sin tocar las demás;
 *   · el servidor guarda los datos de sus fases, con listas largas;
 *   · la ficha del curso no se imprime y cada sesión va en su página;
 *   · ni consejos de investigación ni reglas de «tesista».
 *
 * Que tesis, artículo, informe y TSP no cambian lo vigilan las instantáneas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaMcp = require.resolve('@modelcontextprotocol/server');
const mcpReal = require('@modelcontextprotocol/server');
let registradas = null;
let instrucciones = null;
require.cache[rutaMcp] = {
  id: rutaMcp,
  filename: rutaMcp,
  loaded: true,
  exports: {
    fromJsonSchema: mcpReal.fromJsonSchema,
    McpServer: class {
      constructor(info, opciones) {
        instrucciones = opciones?.instructions ?? null;
      }
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');
const { perfilDe, DOCENTE, TESIS } = require('../src/modules/productos/producto.perfil');
const secciones = require('../src/modules/projects/project.secciones');
const etapas = require('../src/modules/projects/project.etapas');
const { NUNCA_EN_EL_DOCUMENTO } = require('../src/modules/projects/project.esquema');
const { guardarCapituloSchema } = require('../src/modules/projects/project.schema');
const documento = require('../src/modules/projects/project.docx');
const consejos = require('../src/modules/projects/project.consejos');

const SESIONES = 'SESIONES_SUPERIOR';
const TESIS_CODIGO = 'METODO_DE_TESIS_HUMANIZADOR';

function herramientas(productCode) {
  registradas = new Map();
  construirServidor({ productCode });
  return registradas;
}

const esquema = (config) => config.inputSchema['~standard'].jsonSchema.input();

// ── El perfil ──────────────────────────────────────────────────────────────

test('lo que empieza por SESIONES es el perfil docente', () => {
  const p = perfilDe(SESIONES);
  assert.equal(p, DOCENTE);
  assert.equal(p.tipo, 'docente');
  assert.equal(p.archivo, 'sesiones-de-aprendizaje');
  assert.equal(p.revision, null);
  assert.match(p.tuObra, /sesiones/);
  assert.ok(Object.isFrozen(p));
  // Un código desconocido sigue siendo tesis.
  assert.equal(perfilDe('OTRA_COSA'), TESIS);
});

// ── Las herramientas ───────────────────────────────────────────────────────

test('el docente solo tiene las herramientas de sus skills', () => {
  const docente = herramientas(SESIONES);
  assert.deepEqual(
    [...docente.keys()].sort(),
    [
      'continuar',
      'enlace_del_word',
      'estado_licencia',
      'formato_de_la_universidad',
      'guardar_avance',
      'guardar_capitulo',
      'listar_capitulos',
      'material_del_curso',
      'mi_proyecto',
      'redactar',
      'reescribir_parrafos',
      'ver_capitulo',
    ],
  );
  assert.match(instrucciones, /sesiones de aprendizaje/);
  assert.doesNotMatch(instrucciones, /TESISTA/);
});

test('la tesis sigue con las suyas y sin el material del curso', () => {
  const tesis = herramientas(TESIS_CODIGO);
  assert.ok(tesis.has('buscar_en_la_literatura'));
  assert.ok(tesis.has('trabajar_en_r'));
  assert.ok(tesis.has('revisar_la_tesis'));
  assert.ok(!tesis.has('material_del_curso'));
  assert.match(instrucciones, /TESISTA/);
  // Sin «seccion» en sus esquemas: es solo del docente.
  assert.equal(esquema(tesis.get('guardar_capitulo')).properties.seccion, undefined);
  assert.equal(esquema(tesis.get('ver_capitulo')).properties.seccion, undefined);
});

test('los esquemas del docente: una sesión suelta, sin asesor ni norma de citas', () => {
  const docente = herramientas(SESIONES);
  const guardar = esquema(docente.get('guardar_capitulo'));
  assert.ok(guardar.properties.seccion);
  assert.ok(guardar.properties.despuesDe);
  assert.match(guardar.properties.texto.description, /SIN rótulo/);
  assert.ok(esquema(docente.get('ver_capitulo')).properties.seccion);

  const avance = esquema(docente.get('guardar_avance'));
  assert.equal(avance.properties.asesor, undefined);
  assert.equal(avance.properties.estiloCitas, undefined);
  assert.match(avance.properties.datos.description, /sesiones-fase2-sesiones/);

  assert.match(docente.get('material_del_curso').description, /SÍLABO/);
});

// ── Una sola sesión ────────────────────────────────────────────────────────

const CAPITULO = [
  '## Sesión 1 · Primera',
  '',
  '| Momento | Tiempo |',
  '|---|---|',
  '| Inicio | 10 |',
  '',
  '## Sesión 11 · Undécima',
  '',
  'Texto de la 11.',
  '',
  '## Sesión 12 · Duodécima',
  '',
  'Texto de la 12.',
].join('\n');

test('cambiar una sesión deja las demás como estaban', () => {
  const nuevo = secciones.cambiar(CAPITULO, '## Sesión 11 · Corregida\n\nOtro texto.', { seccion: 'sesion 11' });
  assert.match(nuevo, /## Sesión 11 · Corregida\n\nOtro texto\./);
  assert.doesNotMatch(nuevo, /Texto de la 11/);
  assert.match(nuevo, /\| Inicio \| 10 \|/);
  assert.match(nuevo, /Texto de la 12/);
  assert.deepEqual(secciones.titulos(nuevo), ['Sesión 1 · Primera', 'Sesión 11 · Corregida', 'Sesión 12 · Duodécima']);
});

test('«Sesión 1» no se lleva la 11, y la que faltó entra en su sitio', () => {
  assert.equal(secciones.coincide('Sesión 11 · Undécima', 'Sesión 1'), false);
  assert.equal(secciones.coincide('Sesión 12-A · Extra', 'Sesión 12'), false);
  const nuevo = secciones.cambiar(CAPITULO, '## Sesión 11-A · Extra\n\nLa que faltó.', { despuesDe: 'Sesión 11' });
  assert.deepEqual(secciones.titulos(nuevo), [
    'Sesión 1 · Primera',
    'Sesión 11 · Undécima',
    'Sesión 11-A · Extra',
    'Sesión 12 · Duodécima',
  ]);
});

test('si la sesión no está o el texto no trae su título, no se guarda nada', () => {
  assert.throws(() => secciones.cambiar(CAPITULO, '## Sesión 9 · X', { seccion: 'Sesión 9' }), (e) =>
    /No hay ninguna sección «Sesión 9»/.test(e.issues[0].message),
  );
  assert.throws(() => secciones.cambiar(CAPITULO, 'Sin título', { seccion: 'Sesión 11' }), /dos almohadillas/);
  assert.throws(() => secciones.cambiar(CAPITULO, '## S', { seccion: 'Sesión 1', despuesDe: 'Sesión 1' }));
  assert.equal(secciones.leer(CAPITULO, 'Sesión 12'), '## Sesión 12 · Duodécima\n\nTexto de la 12.');
  assert.equal(secciones.leer(CAPITULO, 'Sesión 40'), null);
});

test('guardar_capitulo acepta «seccion» y «despuesDe»', () => {
  const datos = guardarCapituloSchema.parse({ capitulo: 'sesiones-fase2-sesiones', texto: '## Sesión 2', seccion: 'Sesión 2' });
  assert.equal(datos.seccion, 'Sesión 2');
});

// ── Los datos de sus fases ─────────────────────────────────────────────────

test('el servidor guarda los datos de las sesiones, con listas largas', () => {
  const hechas = Array.from({ length: 40 }, (_, i) => `S${i + 1}`);
  const limpio = etapas.limpiar('sesiones-fase2-sesiones', { hechas, grupo: '30 estudiantes', inventado: 'x' });
  assert.equal(limpio.hechas.length, 40);
  assert.equal(limpio.grupo, '30 estudiantes');
  assert.equal(limpio.inventado, undefined);

  const ficha = etapas.limpiar('sesiones-fase0-silabo', { tipoInstitucion: 'iest', notaMinima: '13' });
  assert.deepEqual(ficha, { tipoInstitucion: 'iest', notaMinima: '13' });
  assert.ok(etapas.definicionDe('sesiones-fase1-mapa'));
  assert.ok(etapas.definicionDe('sesiones-fase3-instrumentos'));
  assert.ok(etapas.definicionDe('sesiones-fase4-materiales'));
});

// ── El Word ────────────────────────────────────────────────────────────────

test('la ficha del curso no se imprime', () => {
  assert.ok(NUNCA_EN_EL_DOCUMENTO.has('sesiones-fase0-silabo'));
});

test('con seccionPorPagina, cada sesión salvo la primera abre página', () => {
  const saltos = (contexto) =>
    documento
      .comoParrafos('## Sesión 1\n\nUno.\n\n## Sesión 2\n\nDos.\n\n### Apartado\n\nTres.', contexto)
      .map((p) => JSON.stringify(p).includes('w:pageBreakBefore'));
  // Sesión 1, Uno, Sesión 2, Dos, Apartado, Tres: solo la Sesión 2 abre página.
  assert.deepEqual(saltos({ seccionPorPagina: true }), [false, false, true, false, false, false]);
  // Sin la marca, como siempre: ningún salto.
  assert.deepEqual(saltos({}), [false, false, false, false, false, false]);
});

// ── Consejos ───────────────────────────────────────────────────────────────

test('al docente no le llegan consejos de investigación', async () => {
  assert.equal(await consejos.consejoPara({ userId: 'u', productCode: SESIONES }), null);
});
