'use strict';

/**
 * El conector del artículo empírico entrega la Matriz y la trazabilidad en
 * Excel armadas por el servidor (E2E del 7-nov-2026).
 *
 * - Guardar la Fase 1 devuelve el enlace de MATRIZ.xlsx, hecho con lo guardado.
 * - Al terminar de verificar las citas sale el de TRAZABILIDAD.xlsx.
 * - "enlace_del_word" da también los dos, aunque no haya manuscrito.
 * - En la revisión, guardar la Fase 1 no arma ninguna Matriz.
 * - "anadir_a_mis_fuentes" acepta fuentes sin DOI en el artículo empírico.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

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
      registerTool(nombre, config, manejador) {
        registradas.set(nombre, { ...config, manejador });
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');
const projectService = require('../src/modules/projects/project.service');
const skillService = require('../src/modules/skills/skill.service');
const licenseService = require('../src/modules/licensing/license.service');
const redaccion = require('../src/modules/projects/redaccion.service');
const rService = require('../src/modules/r/r.service');
const enlaceCorto = require('../src/modules/enlaces/enlaceCorto.service');
const verificacion = require('../src/modules/projects/project.verificacion');
const documentoService = require('../src/modules/projects/documento.service');

const MATRIZ = [
  '## 1. Diseño y muestra',
  '| Campo | Contenido |',
  '|---|---|',
  '| Técnica | PLS-SEM |',
  '',
  '## 2. Objetivos',
  '| OE | Pregunta |',
  '|---|---|',
  '| OE1 | ¿Qué relación hay? |',
].join('\n');

const guardados = {};
const armados = [];

licenseService.recordUsage = async () => {};
redaccion.avisosDeRedaccion = async () => [];
skillService.findByCode = async (code) => ({ code, displayName: code });
skillService.perteneceAlGrupo = () => true;
projectService.seccionDelDocumento = async () => null;
projectService.guardarCapitulo = async ({ capitulo, texto }) => {
  guardados[capitulo] = texto;
  return { palabras: texto.split(/\s+/).length };
};
projectService.textoDeCapitulo = async (userId, productCode, codigo) =>
  guardados[codigo] ? { texto: guardados[codigo], partes: 1 } : null;
projectService.enlaceDelWord = async () => null;
documentoService.enlace = async () => null;
rService.libroEnExcel = async ({ hojas, archivo }) => {
  armados.push({ archivo, hojas });
  return { url: `https://api.test/r/descarga/${archivo}`, minutos: 30 };
};
rService.fichaEnWord = async () => ({ url: 'https://api.test/r/descarga/FICHA.docx', minutos: 30 });
enlaceCorto.acortar = async ({ destino }) => destino;

const CITAS = verificacion.inventario(
  [{ code: 'articulo-fase2-introduccion', titulo: 'Introducción', texto: 'Crece la dependencia [AR0A1B2C3D].' }],
  new Map([['AR0A1B2C3D', { ref: 'AR0A1B2C3D', authors: 'Wang, L.', year: 2026, title: 'AI dependence' }]]),
  { 'articulo-fase2-introduccion:AR0A1B2C3D': { estado: 'lo_dice', huella: null } },
).map((i) => ({ ...i, estado: 'lo_dice' }));
projectService.verificarCitas = async () => ({
  items: CITAS,
  recuento: verificacion.recuento(CITAS),
  aplicadas: [],
  rechazadas: [],
});

const LICENCIA = (productCode) => ({ id: 'lic', userId: 'u1', productCode, user: { id: 'u1' } });

function herramientas(productCode) {
  registradas = new Map();
  construirServidor(LICENCIA(productCode));
  return registradas;
}

const textoDe = (respuesta) => respuesta.content.map((c) => c.text).join('\n');

test('guardar la Fase 1 del artículo devuelve la Matriz en Excel armada con lo guardado', async () => {
  armados.length = 0;
  const h = herramientas('ARTICULO_SCIENTIFICOS');
  const r = textoDe(
    await h.get('guardar_capitulo').manejador({ capitulo: 'articulo-fase1-matriz-de-estrategia', texto: MATRIZ }),
  );
  assert.match(r, /LA MATRIZ EN EXCEL YA ESTÁ ARMADA/);
  assert.match(r, /MATRIZ\.xlsx/);
  assert.doesNotMatch(r, /la ficha está en el chat/);
  assert.equal(armados.length, 1);
  assert.deepEqual(armados[0].hojas.map((x) => x.nombre), ['1. Diseño y muestra', '2. Objetivos']);
});

test('en la revisión, guardar la Fase 1 no arma ninguna Matriz', async () => {
  armados.length = 0;
  const h = herramientas('ARTICULOS_REVIEW');
  const r = textoDe(
    await h.get('guardar_capitulo').manejador({ capitulo: 'revision-fase1-protocolo', texto: MATRIZ }),
  );
  assert.doesNotMatch(r, /MATRIZ/);
  assert.equal(armados.length, 0);
});

test('al terminar de verificar las citas sale la trazabilidad en Excel', async () => {
  armados.length = 0;
  const h = herramientas('ARTICULO_SCIENTIFICOS');
  const r = textoDe(await h.get('verificar_citas').manejador({}));
  assert.match(r, /TODAS LAS CITAS ESTÁN VERIFICADAS/);
  assert.match(r, /TRAZABILIDAD\.xlsx/);
  assert.equal(armados[0].archivo, 'TRAZABILIDAD.xlsx');
  assert.equal(armados[0].hojas[0].filas[1][1], 'AR0A1B2C3D');
});

test('enlace_del_word da la Ficha, la Matriz y la trazabilidad aunque no haya manuscrito', async () => {
  guardados['articulo-fase0-tema-y-orientacion'] = 'Ficha';
  guardados['articulo-fase1-matriz-de-estrategia'] = MATRIZ;
  const h = herramientas('ARTICULO_SCIENTIFICOS');
  const r = textoDe(await h.get('enlace_del_word').manejador({}));
  assert.match(r, /Las fichas de trabajo sí/);
  assert.match(r, /- Ficha: .*FICHA\.docx/);
  assert.match(r, /- Matriz de Estrategia: .*MATRIZ\.xlsx/);
  assert.match(r, /- Trazabilidad de las citas: .*TRAZABILIDAD\.xlsx/);
});

test('anadir_a_mis_fuentes acepta fuentes sin DOI también en el artículo empírico', () => {
  const esquema = (p) => herramientas(p).get('anadir_a_mis_fuentes').inputSchema['~standard'].jsonSchema.input();
  assert.ok(esquema('ARTICULO_SCIENTIFICOS').properties.sinDoi);
  assert.ok(esquema('ARTICULOS_REVIEW').properties.sinDoi);
  assert.ok(!esquema('METODO_DE_TESIS_HUMANIZADOR').properties.sinDoi, 'la tesis sigue igual');
});

test('la lista de fases dice de qué ruta es, no «Método de tesis»', async () => {
  skillService.listCatalog = async () => [
    { code: 'articulo-fase1-matriz-de-estrategia', displayName: 'Fase 1', summary: 'Matriz' },
  ];
  const lista = async (p) => textoDe(await herramientas(p).get('listar_capitulos').manejador({}));
  assert.match(await lista('ARTICULO_SCIENTIFICOS'), /^Ruta del Artículo Empírico — Acosta/);
  assert.match(await lista('ARTICULOS_REVIEW'), /^Ruta del Artículo de Revisión — Acosta/);
  assert.match(await lista('METODO_DE_TESIS_HUMANIZADOR'), /^Método de tesis — Acosta/);
});
