'use strict';

/**
 * Un capítulo propio del reglamento de su facultad («propio-…») se lee con
 * párrafos numerados y se le cambian párrafos sueltos, igual que a uno del
 * método.
 *
 * Hasta el 7-nov-2026, "ver_capitulo" ignoraba "numerado" en esos capítulos (los
 * devolvía por partes, sin ningún ¶) y "reescribir_parrafos" contestaba «No
 * existe ningún capítulo con la clave». Lo vio un tesista de TFM con su
 * Capítulo 4 de 6.715 palabras.
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
        registradas.set(nombre, manejador);
      }
    },
  },
};

const licenseService = require('../src/modules/licensing/license.service');
const projectService = require('../src/modules/projects/project.service');
const skillService = require('../src/modules/skills/skill.service');
const redaccion = require('../src/modules/projects/redaccion.service');
const { construirServidor } = require('../src/modules/mcp/mcp.tools');

const CLAVE = 'propio-capitulo-4';
const PROPIO = { code: CLAVE, displayName: 'Capítulo 4', productCodes: [] };
const llamadas = [];

licenseService.recordUsage = async () => {};
projectService.seccionDelDocumento = async (userId, productCode, clave) => (clave === CLAVE ? PROPIO : null);
// Una clave propia no está en el catálogo.
skillService.findByCode = async () => null;
projectService.textoDeCapitulo = async () => ({
  skill: PROPIO,
  vacio: false,
  texto: 'Texto sin numerar.',
  parte: 1,
  partes: 2,
  palabras: 6715,
});
redaccion.capituloNumerado = async (userId, productCode, capitulo, opciones) => {
  llamadas.push({ capitulo, ...opciones });
  return { lineas: ['¶1 [titulo] Capítulo 4', '¶2 Primer párrafo.'], siguiente: 40, total: 80, palabras: 6715 };
};
redaccion.reescribirParrafos = async ({ capitulo, parrafos }) => {
  llamadas.push({ capitulo, parrafos });
  return { guardados: parrafos.length, rechazados: [], avisos: [], palabras: 6715 };
};

function herramientas() {
  registradas = new Map();
  construirServidor({ id: 'lic-1', productCode: 'METODO_DE_TESIS_HUMANIZADOR', user: { id: 'u-1' } });
  return registradas;
}

const salida = (r) => r.content.map((c) => c.text).join('\n');

test('ver_capitulo numera un capítulo propio de su facultad', async () => {
  llamadas.length = 0;
  const r = await herramientas().get('ver_capitulo')({ capitulo: CLAVE, texto: true, numerado: true });
  const t = salida(r);
  assert.match(t, /¶2 Primer párrafo\./);
  assert.match(t, /"desde": 40/);
  assert.doesNotMatch(t, /parte 1 de 2/);
  assert.deepEqual(llamadas, [{ capitulo: CLAVE, desde: undefined }]);
});

test('ver_capitulo con "desde" sigue donde se cortó', async () => {
  llamadas.length = 0;
  await herramientas().get('ver_capitulo')({ capitulo: CLAVE, texto: true, numerado: true, desde: 40 });
  assert.deepEqual(llamadas, [{ capitulo: CLAVE, desde: 40 }]);
});

test('sin "numerado", un capítulo propio sigue saliendo por partes', async () => {
  const t = salida(await herramientas().get('ver_capitulo')({ capitulo: CLAVE, texto: true }));
  assert.match(t, /parte 1 de 2/);
  assert.doesNotMatch(t, /¶/);
});

test('reescribir_parrafos acepta un capítulo propio de su facultad', async () => {
  llamadas.length = 0;
  const parrafos = [{ p: 2, texto: 'Primer párrafo, reescrito.' }];
  const t = salida(await herramientas().get('reescribir_parrafos')({ capitulo: CLAVE, parrafos }));
  assert.doesNotMatch(t, /No existe ningún capítulo/);
  assert.deepEqual(llamadas, [{ capitulo: CLAVE, parrafos }]);
});

test('reescribir_parrafos sigue rechazando una clave que no existe', async () => {
  llamadas.length = 0;
  const t = salida(
    await herramientas().get('reescribir_parrafos')({ capitulo: 'propio-otro', parrafos: [{ p: 1, texto: 'x' }] }),
  );
  assert.match(t, /No existe ningún capítulo con la clave "propio-otro"/);
  assert.deepEqual(llamadas, []);
});
