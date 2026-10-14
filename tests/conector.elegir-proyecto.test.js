'use strict';

/**
 * Elegir con cuál de sus tesis se trabaja, desde la conversación.
 *
 * La activa solo se cambiaba en el panel. Esto fija que quien tiene el permiso
 * de «varias tesis» recibe la pregunta en "mi_proyecto" y puede cambiarla con
 * "elegir_proyecto", y que a todos los demás no les aparece nada nuevo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

let tesis = [];
const activadas = [];

sustituir('../src/modules/licensing/license.service', { recordUsage: async () => {} });
sustituir('../src/modules/projects/documento.service', { aviso: async () => null });
sustituir('../src/modules/projects/project.consejos', { consejoPara: async () => null });
sustituir('../src/modules/projects/project.service', {
  resumen: async () => 'PANORAMA',
  tesisDelMetodo: async () => tesis,
  activarTesis: async ({ id }) => {
    activadas.push(id);
    return tesis.some((t) => t.id === id);
  },
});

const rutaMcp = require.resolve('@modelcontextprotocol/server');
const mcpReal = require('@modelcontextprotocol/server');
let registradas = new Map();
require.cache[rutaMcp] = {
  id: rutaMcp,
  filename: rutaMcp,
  loaded: true,
  exports: {
    fromJsonSchema: mcpReal.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config, manejador) {
        registradas.set(nombre, { config, manejador });
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');

const DOS = [
  { id: 'a', nombre: null, tema: 'Clima laboral', activa: true, palabras: 1200 },
  { id: 'b', nombre: 'La de salud', tema: null, activa: false, palabras: 0 },
];

function servidor({ variasTesis }) {
  registradas = new Map();
  activadas.length = 0;
  construirServidor({ id: 'lic1', productCode: 'METODO_9_SKILLS', user: { id: 'u1' }, delivery: 'SKILLS', variasTesis });
}

async function llamar(nombre, argumentos = {}) {
  const respuesta = await registradas.get(nombre).manejador(argumentos);
  return respuesta.content.map((c) => c.text).join('\n');
}

test('sin el permiso de varias tesis no hay herramienta ni pregunta', async () => {
  tesis = DOS;
  servidor({ variasTesis: false });

  assert.equal(registradas.has('elegir_proyecto'), false);
  assert.equal(await llamar('mi_proyecto'), 'PANORAMA');
});

test('con el permiso y una sola tesis, mi_proyecto no pregunta nada', async () => {
  tesis = [DOS[0]];
  servidor({ variasTesis: true });

  assert.equal(await llamar('mi_proyecto'), 'PANORAMA');
});

test('con dos tesis, mi_proyecto las lista delante y manda preguntar', async () => {
  tesis = DOS;
  servidor({ variasTesis: true });

  const texto = await llamar('mi_proyecto');
  assert.match(texto, /^TIENE 2 TRABAJOS/);
  assert.match(texto, /1\. «Principal» — Clima laboral · 1200 palabras ← ACTIVA/);
  assert.match(texto, /2\. «La de salud» — sin tema todavía/);
  assert.match(texto, /PREGÚNTALE con cuál/);
  assert.ok(texto.endsWith('PANORAMA'), 'el panorama sigue saliendo, debajo');
});

test('elegir_proyecto cambia la activa por su número', async () => {
  tesis = DOS;
  servidor({ variasTesis: true });

  const texto = await llamar('elegir_proyecto', { numero: 2 });
  assert.deepEqual(activadas, ['b']);
  assert.match(texto, /Ahora el activo es «La de salud»/);
});

test('elegir la que ya está activa, o un número que no existe, no cambia nada', async () => {
  tesis = DOS;
  servidor({ variasTesis: true });

  assert.match(await llamar('elegir_proyecto', { numero: 1 }), /ya era el activo/);
  assert.match(await llamar('elegir_proyecto', { numero: 7 }), /No hay ningún trabajo con el número 7/);
  assert.match(await llamar('elegir_proyecto'), /Sus trabajos en este método/);
  assert.deepEqual(activadas, []);
});
