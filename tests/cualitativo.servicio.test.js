'use strict';

/**
 * El análisis cualitativo de punta a punta, sin base ni disco: subir, listar,
 * leer por tandas, codificar y la herramienta «analisis_cualitativo».
 *
 * Lo que tiene que ser cierto:
 *
 *   · cada entrevista recibe su número (E1, E2…) y lo conserva al volver a
 *     subirla, pero pierde sus citas;
 *   · «ver» reparte los párrafos en tandas y dice por dónde seguir;
 *   · una codificación con una cita inventada no se guarda;
 *   · la herramienta existe en tesis, artículo e informe, y su enlace es suyo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';
const ARTICULO = 'ARTICULO_SCIENTIFICOS';
const INFORME = 'INFORME_PRUEBA01';

const estado = { proyecto: { id: 'p1', stages: [] }, archivos: {}, conLicencia: [TESIS] };

sustituir('../src/modules/projects/project.repository', {
  productosConLicencia: async () => estado.conLicencia,
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/projects/project.storage', {
  leerCualitativo: async (projectId, que) => structuredClone(estado.archivos[que] ?? null),
  guardarCualitativo: async (projectId, que, valor) => {
    estado.archivos[que] = valor === null || valor === undefined ? null : structuredClone(valor);
  },
  leer: async () => null,
  fechaDeAnalisis: async () => null,
});

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
      registerTool(nombre, config, handler) {
        registradas.set(nombre, { config, handler });
      }
    },
  },
};

const licenseService = require('../src/modules/licensing/license.service');
licenseService.recordUsage = async () => {};

const servicio = require('../src/modules/cualitativo/cualitativo.service');
const enlaces = require('../src/modules/cualitativo/cualitativo.enlaces');
const subidaMaterial = require('../src/modules/projects/project.subida-material');
const { construirServidor } = require('../src/modules/mcp/mcp.tools');

const txt = (lineas) => Buffer.from(lineas.join('\n'), 'utf8');

const ENTREVISTA_1 = [
  'Entrevistador: ¿Cómo fue su experiencia con el asesor?',
  'Participante: El profesor nunca respondía mis correos, tuve que buscar ayuda afuera.',
];

function empezar() {
  estado.proyecto = { id: 'p1', stages: [] };
  estado.archivos = {};
  estado.conLicencia = [TESIS];
}

function herramientas(productCode) {
  registradas = new Map();
  construirServidor({ productCode, id: 'l1', user: { id: 'u1' } });
  return registradas;
}

async function llamar(args, productCode = TESIS) {
  const { handler } = herramientas(productCode).get('analisis_cualitativo');
  const respuesta = await handler(args);
  return respuesta.content[0].text;
}

test('subir: numera E1, E2… y la lista no lleva el texto', async () => {
  empezar();
  const a = await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  const b = await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(['P: Hola.']), nombre: 'luis.txt' });
  assert.equal(a.id, 'E1');
  assert.equal(b.id, 'E2');
  const lista = await servicio.lista('u1', TESIS);
  assert.deepEqual(lista.map((e) => [e.id, e.nombre, e.parrafos]), [['E1', 'ana.txt', 2], ['E2', 'luis.txt', 1]]);
  assert.equal(typeof lista[0].parrafos, 'number', 'la lista lleva cuántos párrafos, no el texto');
});

test('sin licencia de ese método no se guarda', async () => {
  empezar();
  estado.conLicencia = [];
  assert.equal(await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'a.txt' }), null);
});

test('volver a subir con el mismo nombre conserva el número y quita sus citas', async () => {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  await servicio.codificar('u1', TESIS, 'E1', {
    codigos: [{ nombre: 'Apoyo', definicion: 'x' }],
    citas: [{ parrafo: 2, texto: 'nunca respondía', codigos: ['Apoyo'] }],
  });
  const otra = await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  assert.equal(otra.id, 'E1');
  assert.equal(otra.reemplazo, true);
  assert.equal(otra.citasPerdidas, 1);
  assert.equal(estado.archivos.codificacion.citas.length, 0);
  assert.equal(estado.archivos.codificacion.codigos.length, 1, 'el libro se queda');
});

test('ver: reparte en tandas y dice por dónde seguir', async () => {
  empezar();
  const largo = Array.from({ length: 40 }, (_, i) => `P: Respuesta ${i + 1}. ${'palabra '.repeat(80)}`);
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(largo), nombre: 'larga.txt' });
  const primera = await servicio.ver('u1', TESIS, 'e1');
  assert.ok(primera.siguiente > 1);
  assert.ok(primera.parrafos.reduce((s, p) => s + p.texto.length, 0) <= servicio.POR_TANDA);
  const segunda = await servicio.ver('u1', TESIS, 'E1', { desde: primera.siguiente });
  assert.equal(segunda.parrafos[0].numero, primera.siguiente);
  assert.equal(await servicio.ver('u1', TESIS, 'E9'), null);
});

test('la herramienta: lista vacía con su enlace, que no vale como el del material', async () => {
  empezar();
  const respuesta = await llamar({});
  assert.match(respuesta, /Todavía no ha subido ninguna entrevista/);
  const url = /https?:\/\/\S+\/subir-entrevistas\/([^\s)]+)/.exec(respuesta);
  assert.ok(url, 'da el enlace de subida');
  assert.equal(enlaces.verificar(url[1]).userId, 'u1');
  assert.throws(() => subidaMaterial.verificar(url[1]));
});

test('la herramienta: ver, codificar con una cita inventada (no guarda) y bien (guarda)', async () => {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });

  assert.match(await llamar({ accion: 'ver', entrevista: 'E1' }), /¶2 Participante: El profesor nunca/);

  const mal = await llamar({
    accion: 'codificar',
    entrevista: 'E1',
    codigos: [{ nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.' }],
    citas: [{ parrafo: 2, texto: 'el profesor jamás contestaba', codigos: ['Falta de apoyo docente'] }],
  });
  assert.match(mal, /No se guardó nada/);
  assert.equal(estado.archivos.codificacion ?? null, null);

  const bien = await llamar({
    accion: 'codificar',
    entrevista: 'E1',
    codigos: [{ nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.', categoria: 'Barreras' }],
    citas: [{ parrafo: 2, texto: 'El profesor nunca respondía mis correos', codigos: ['Falta de apoyo docente'] }],
  });
  assert.match(bien, /1 citas, todas comprobadas/);

  const libro = await llamar({ accion: 'libro' });
  assert.match(libro, /Barreras\n- Falta de apoyo docente \(1 citas, 1 entrevistas\)/);
  assert.match(libro, /E1 · «ana\.txt» · 2 párrafos · 1 citas codificadas/);
});

test('la herramienta: «codificar» sin citas no borra lo guardado', async () => {
  empezar();
  await servicio.guardar({ userId: 'u1', productCode: TESIS, buffer: txt(ENTREVISTA_1), nombre: 'ana.txt' });
  await servicio.codificar('u1', TESIS, 'E1', {
    codigos: [{ nombre: 'Apoyo', definicion: 'x' }],
    citas: [{ parrafo: 2, texto: 'nunca respondía', codigos: ['Apoyo'] }],
  });
  assert.match(await llamar({ accion: 'codificar', entrevista: 'E1' }), /No se guardó nada/);
  assert.equal(estado.archivos.codificacion.citas.length, 1);
});

test('la herramienta está en tesis, artículo e informe', () => {
  for (const producto of [TESIS, ARTICULO, INFORME]) {
    assert.ok(herramientas(producto).has('analisis_cualitativo'), producto);
  }
});
