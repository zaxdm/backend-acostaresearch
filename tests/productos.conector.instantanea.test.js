'use strict';

/**
 * Las herramientas del conector de tesis y de artículo, congeladas.
 *
 * Nombre, título, descripción y esquema de entrada de cada herramienta, tal y
 * como salen en `tools/list`. Es lo que Claude lee antes de decidir nada, y un
 * producto nuevo que cambie una de estas descripciones cambia cómo trabaja el
 * Claude de quien ya compró. Ver `instantaneas/instantanea.js`.
 *
 * Mismo `McpServer` de mentira que `mcp.descripciones`: no toca la base ni
 * llama a nada, porque todo el trabajo real vive en los handlers.
 */

const test = require('node:test');

const { comparar } = require('./instantaneas/instantanea');

const ruta = require.resolve('@modelcontextprotocol/server');
const real = require('@modelcontextprotocol/server');

let registradas = null;

require.cache[ruta] = {
  id: ruta,
  filename: ruta,
  loaded: true,
  exports: {
    fromJsonSchema: real.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');

/** Lo que ve Claude de cada herramienta, en el orden en que se registran. */
function herramientasDe(productCode) {
  registradas = new Map();
  construirServidor({ productCode });
  return [...registradas].map(([nombre, config]) => ({
    nombre,
    titulo: config.title ?? null,
    descripcion: config.description ?? null,
    esquema: config.inputSchema?.['~standard']?.jsonSchema?.input?.() ?? null,
  }));
}

for (const productCode of ['METODO_9_SKILLS', 'METODO_DE_TESIS_HUMANIZADOR', 'ARTICULO_SCIENTIFICOS']) {
  test(`el conector de ${productCode} no cambia`, () => {
    comparar(`conector.${productCode}`, herramientasDe(productCode));
  });
}
