'use strict';

/**
 * Leer el texto guardado de un capítulo, por partes.
 *
 * La Discusión se escribe contra los Resultados y las Conclusiones contra todo
 * lo anterior. Sin esto, las skills le pedían al tesista que pegara en la
 * conversación lo que ya estaba guardado en el servidor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const estado = {
  proyecto: { id: 'p1', stages: [] },
  texto: null,
  delGrupo: true,
};

const SKILL = { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' };

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/modules/projects/project.repository', { buscar: async () => estado.proyecto });
sustituir('../src/modules/projects/project.storage', {
  leer: async () => estado.texto,
  palabrasDe: (texto) => texto.trim().split(/\s+/).length,
  leerFichaDeDocumento: async () => null,
});
sustituir('../src/modules/skills/skill.service', {
  findByCode: async (code) => (code === SKILL.code ? SKILL : null),
  perteneceAlGrupo: () => estado.delGrupo,
  listCatalog: async () => [],
});
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const servicio = require('../src/modules/projects/project.service');

const leer = (opciones) => servicio.textoDeCapitulo('u1', 'METODO', SKILL.code, opciones);

test.beforeEach(() => {
  estado.proyecto = { id: 'p1', stages: [] };
  estado.texto = null;
  estado.delGrupo = true;
});

test('un capítulo de otro método no se lee', async () => {
  estado.delGrupo = false;
  estado.texto = 'Algo.';
  assert.equal(await leer(), null);
});

test('un capítulo sin texto lo dice, en vez de devolver una parte vacía', async () => {
  const r = await leer();
  assert.equal(r.vacio, true);
  assert.equal(r.skill.code, SKILL.code);
});

test('un capítulo corto sale entero en una parte, con sus claves de cita intactas', async () => {
  estado.texto = '## 4.1 Resultados\n\nLa media fue 3,4 [AR11111111].';
  const r = await leer();
  assert.equal(r.partes, 1);
  assert.equal(r.parte, 1);
  assert.equal(r.texto, estado.texto);
  assert.equal(r.palabras, 8);
});

test('uno largo sale por partes que empiezan en un párrafo y juntas son el texto entero', async () => {
  const parrafos = Array.from({ length: 60 }, (_, i) => `Párrafo ${i + 1}. ${'x'.repeat(990)}`);
  estado.texto = parrafos.join('\n\n');

  const primera = await leer();
  assert.equal(primera.partes, 3);

  const todas = [];
  for (let parte = 1; parte <= primera.partes; parte += 1) {
    const r = await leer({ parte });
    assert.ok(r.texto.length <= 24000);
    assert.match(r.texto, /^Párrafo \d+\./, 'cada parte empieza al principio de un párrafo');
    todas.push(r.texto);
  }
  assert.equal(todas.join('\n\n'), estado.texto);
});

test('pedir una parte que no existe da la última, no un error', async () => {
  estado.texto = Array.from({ length: 60 }, () => 'y'.repeat(1000)).join('\n\n');
  const r = await leer({ parte: 99 });
  assert.equal(r.parte, r.partes);
});

test('el panorama dice si hay formato de la universidad y, si no, que se pregunte', () => {
  assert.match(
    servicio.lineaDeFormato({ plantillaAt: new Date(), plantillaNombre: 'Formato UNMSM.docx' }),
    /puesto \(«Formato UNMSM\.docx»\)/,
  );
  const sinFormato = servicio.lineaDeFormato({ plantillaAt: null });
  assert.match(sinFormato, /PREGÚNTALE UNA VEZ/);
  assert.match(sinFormato, /formato_de_la_universidad/);
});

test('un párrafo solo más largo que una parte se corta a la fuerza', () => {
  const partes = servicio.enPartes('z'.repeat(50000));
  assert.deepEqual(partes.map((p) => p.length), [24000, 24000, 2000]);
});
