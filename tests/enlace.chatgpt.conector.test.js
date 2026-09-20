'use strict';

/**
 * Que el conector de verdad reparta el enlace en la forma de cada asistente.
 *
 * `enlace.chatgpt.test.js` fija los dos textos; esto fija el CABLEADO, que es lo
 * que se puede romper sin que salte nada: basta con que alguien añada una
 * herramienta con enlace y llame a `enlaceClic` en vez de a `darEnlace`, o que
 * el router deje de mirar la cabecera, para que ChatGPT vuelva a mandar al
 * tesista a la portada.
 *
 * Se ejercita `subir_mi_documento` entero, del constructor del servidor a la
 * respuesta que lee el asistente.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const URL_FALSA = 'https://acostaresearch.com/subir-documento/eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJ4In0.abc-_123';

sustituir('../src/modules/licensing/license.service', { recordUsage: async () => {} });
sustituir('../src/modules/projects/documento.service', { fichaDe: async () => null });
sustituir('../src/modules/projects/project.subida-documento', {
  enlace: () => ({ url: URL_FALSA, minutos: 30 }),
  MINUTOS: 30,
});

// El SDK, cambiado por uno que se queda con los manejadores para poder llamarlos.
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
const { clienteDe } = require('../src/modules/mcp/mcp.cliente');

const LICENCIA = {
  id: 'lic1',
  productCode: 'INFORME_ESTUDIANTIL',
  user: { id: 'u1' },
  delivery: 'SKILLS',
};

/** Llama a una herramienta como lo haría el asistente y devuelve su texto. */
async function llamar(nombre, { cliente }) {
  registradas = new Map();
  construirServidor(LICENCIA, { cliente });
  const { manejador } = registradas.get(nombre);
  const respuesta = await manejador({});
  return respuesta.content.map((c) => c.text).join('\n');
}

test('desde ChatGPT sale la dirección entera, nunca dentro de un enlace de Markdown', async () => {
  const texto = await llamar('subir_mi_documento', { cliente: clienteDe('openai-mcp/1.0.0') });

  assert.ok(texto.includes(`\n${URL_FALSA}\n`), 'la dirección va sola en su línea');
  assert.ok(!texto.includes(`](${URL_FALSA})`), 'a ChatGPT no se le pide Markdown');
  assert.match(texto, /NO la metas en un bloque de código/);
  assert.match(texto, /NO la escribas como enlace con un texto encima/);
});

test('desde Claude sigue saliendo el enlace que se pulsa, sin enseñar la dirección', async () => {
  const texto = await llamar('subir_mi_documento', { cliente: clienteDe('Claude-User') });

  assert.ok(texto.includes(`](${URL_FALSA})`), 'a Claude se le da el enlace hecho');
  assert.match(texto, /NO escribas la dirección/);
});

test('sin decir con quién se habla, el conector se comporta como antes', async () => {
  registradas = new Map();
  construirServidor(LICENCIA);
  const { manejador } = registradas.get('subir_mi_documento');
  const texto = (await manejador({})).content.map((c) => c.text).join('\n');

  assert.ok(texto.includes(`](${URL_FALSA})`));
});
