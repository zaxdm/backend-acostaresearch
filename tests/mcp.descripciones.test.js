'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lo que Claude lee ANTES de decidir: las descripciones de `tools/list`.
 *
 * Una descripción no se ejecuta nunca, así que ninguna prueba de lógica la
 * cubre: se puede romper entera sin que falle un solo test. Y sin embargo es
 * lo único que decide si el tesista llega o no a las herramientas de apoyo.
 *
 * Aquí se monta el servidor con un `McpServer` de mentira que solo apunta lo
 * que se registra. No toca la base, no abre conexiones y no llama a ningún
 * servicio: `construirServidor` es síncrono y todo el trabajo real vive dentro
 * de los handlers, que estas pruebas no invocan.
 */

const ruta = require.resolve('@modelcontextprotocol/server');
const real = require('@modelcontextprotocol/server');

const registradas = new Map();

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

construirServidor({ productCode: 'METODO_DE_TESIS_HUMANIZADOR' });

/** La descripción tal y como sale en `tools/list`. */
const descripcion = (nombre) => registradas.get(nombre).description;

/** El JSON Schema de verdad: `fromJsonSchema` lo esconde tras un envoltorio. */
const esquema = (nombre) =>
  registradas.get(nombre).inputSchema['~standard'].jsonSchema.input();

// ── listar_capitulos ───────────────────────────────────────────────────────

test('listar_capitulos ya no se desaconseja a sí misma', () => {
  const d = descripcion('listar_capitulos');
  assert.ok(
    !/no hace falta/i.test(d),
    'la frase «si ya llamaste a mi_proyecto, no hace falta» la apagaba entera',
  );
});

test('listar_capitulos anuncia las herramientas de apoyo, no solo capítulos', () => {
  const d = descripcion('listar_capitulos');
  assert.match(d, /herramientas de apoyo/);
  assert.match(d, /capítulos/);
});

test('listar_capitulos dice que el catálogo es de esta licencia', () => {
  assert.match(descripcion('listar_capitulos'), /ESTA licencia/);
});

test('listar_capitulos reparte el papel con mi_proyecto', () => {
  const d = descripcion('listar_capitulos');
  assert.match(d, /mi_proyecto/, 'sin el reparto, se llama por costumbre');
  assert.match(d, /No en cada conversación/);
});

// ── redactar ───────────────────────────────────────────────────────────────

test('redactar conserva lo que ya decía del método', () => {
  const d = descripcion('redactar');
  assert.match(d, /método de Acosta \| IA & Research/);
  assert.match(d, /manda el mismo "sesion" en cada llamada del mismo hilo/);
});

test('redactar dice que también abre las herramientas de apoyo', () => {
  const d = descripcion('redactar');
  assert.match(d, /herramientas de apoyo/);
  assert.match(d, /mismo "capitulo"/, 'hay que decir POR DÓNDE se abren');
});

test('redactar desmiente que las herramientas esperen al final de la tesis', () => {
  assert.match(descripcion('redactar'), /NO esperan a que la tesis esté terminada/);
});

test('redactar nombra el insumo que dispara cada herramienta, no la frase', () => {
  const d = descripcion('redactar');
  assert.match(d, /informe de similitud/);
  assert.match(d, /suena a IA/);
});

test('redactar no hardcodea las claves de las herramientas', () => {
  const d = descripcion('redactar');
  for (const clave of ['bajar-similitud', 'humanizador-academico']) {
    assert.ok(!d.includes(clave), `${clave} debe venir del catálogo, no del texto`);
  }
});

test('redactar remite a listar_capitulos para el detalle', () => {
  assert.match(descripcion('redactar'), /listar_capitulos/);
});

// ── El parámetro que Claude rellena ────────────────────────────────────────

test('el parámetro capitulo de redactar admite herramientas de apoyo', () => {
  const d = esquema('redactar').properties.capitulo.description;
  assert.match(d, /herramienta de apoyo/);
  assert.match(d, /listar_capitulos/);
});

test('guardar_capitulo sigue hablando solo de capítulos', () => {
  const d = esquema('guardar_capitulo').properties.capitulo.description;
  assert.equal(d, 'Clave del capítulo, tal como aparece en listar_capitulos.');
});

// ── Que no se haya movido nada más ─────────────────────────────────────────

test('siguen registradas las mismas 16 herramientas', () => {
  assert.equal(registradas.size, 16);
  for (const nombre of [
    'listar_capitulos',
    'mi_proyecto',
    'continuar',
    'ver_capitulo',
    'ver_analisis',
    'redactar',
  ]) {
    assert.ok(registradas.has(nombre), `falta ${nombre}`);
  }
});

test('redactar mantiene sus parámetros y su obligatorio', () => {
  const e = esquema('redactar');
  assert.deepEqual(Object.keys(e.properties).sort(), [
    'capitulo',
    'mensaje',
    'paso',
    'referencia',
    'sesion',
  ]);
});

test('listar_capitulos sigue sin admitir argumentos', () => {
  const e = esquema('listar_capitulos');
  assert.deepEqual(e.properties, {});
  assert.equal(e.additionalProperties, false);
});
