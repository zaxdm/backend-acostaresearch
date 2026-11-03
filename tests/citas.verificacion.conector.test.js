'use strict';

/**
 * `verificar_citas` solo existe en el conector del artículo empírico (3-nov-2026).
 * La revisión empieza también por ARTICULO y no la lleva; la tesis tampoco.
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
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');

function herramientas(productCode) {
  registradas = new Map();
  construirServidor({ productCode });
  return registradas;
}

test('verificar_citas está en el artículo empírico y en ningún otro', () => {
  assert.ok(herramientas('ARTICULO_SCIENTIFICOS').has('verificar_citas'));
  assert.ok(!herramientas('ARTICULOS_REVIEW').has('verificar_citas'));
  assert.ok(!herramientas('METODO_DE_TESIS_HUMANIZADOR').has('verificar_citas'));
  assert.ok(!herramientas('INFORME_ESTUDIANTIL').has('verificar_citas'));
});
