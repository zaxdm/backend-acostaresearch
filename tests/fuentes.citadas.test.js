'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lo citado en un capítulo no se borra.
 *
 * La clave de una fuente sale de un `id` aleatorio: borrarla y volver a subirla
 * da otra clave, y la cita del capítulo queda como «CITA SIN LOCALIZAR» en el
 * Word. Se prueba que las dos vías que borran fuentes de un tesista —«Borrar
 * todas» y la limpieza de su Zotero— dejan fuera lo citado, y que se reúnen las
 * citas de todos sus proyectos.
 */

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── La base y el disco, de mentira ──────────────────────────────────────────

const llamadas = [];
const prisma = {
  reference: {
    deleteMany: async (args) => {
      llamadas.push(['deleteMany', args]);
      return { count: 7 };
    },
    count: async (args) => {
      llamadas.push(['count', args]);
      return 2;
    },
  },
};
sustituir('../src/lib/prisma', prisma);

let proyectos = [];
const leidos = [];
const textos = {};
sustituir('../src/modules/projects/project.repository', {
  listarDeUsuario: async () => proyectos,
});
sustituir('../src/modules/projects/project.storage', {
  leer: async (projectId, skillCode) => {
    leidos.push(`${projectId}/${skillCode}`);
    return textos[`${projectId}/${skillCode}`] ?? null;
  },
});

const { clavesCitadas } = require('../src/modules/references/citadas');
const propiasRepository = require('../src/modules/references/propias.repository');
const bibliotecaRepository = require('../src/modules/zotero/biblioteca.repository');

function empezar() {
  llamadas.length = 0;
  leidos.length = 0;
}

// ── Qué está citado ─────────────────────────────────────────────────────────

test('se reúnen las citas de todos sus proyectos, sin repetir', async () => {
  empezar();
  proyectos = [
    {
      id: 'p1',
      stages: [
        { skillCode: 'problema-y-objetivos', palabras: 900 },
        { skillCode: 'marco-teorico', palabras: 0 },
      ],
    },
    { id: 'p2', stages: [{ skillCode: 'articulo-fase2-introduccion', palabras: 400 }] },
  ];
  textos['p1/problema-y-objetivos'] = 'Crece el comercio [AR5CCC19E0] y lo dicen [AR91D3F60D:n] autores.';
  textos['p1/marco-teorico'] = 'Esto no se lee [AR00000000].';
  textos['p2/articulo-fase2-introduccion'] = 'Otra vez [AR5CCC19E0][ARB39FEB61:p. 45].';

  assert.deepEqual(await clavesCitadas('u1'), ['AR5CCC19E0', 'AR91D3F60D', 'ARB39FEB61']);
  assert.ok(!leidos.includes('p1/marco-teorico'), 'un capítulo sin palabras no se abre');
});

test('sin proyectos o sin capítulos escritos no hay nada citado', async () => {
  empezar();
  proyectos = [];
  assert.deepEqual(await clavesCitadas('u1'), []);
});

// ── «Borrar todas» ──────────────────────────────────────────────────────────

test('sin nada citado, «Borrar todas» borra todas', async () => {
  empezar();
  const resultado = await propiasRepository.vaciar('u1', []);

  assert.deepEqual(resultado, { borradas: 7, conservadas: 0 });
  assert.deepEqual(llamadas, [['deleteMany', { where: { ownerUserId: 'u1' } }]]);
});

test('lo citado se queda, y se dice cuántas', async () => {
  empezar();
  const citadas = ['AR5CCC19E0', 'AR91D3F60D'];
  const resultado = await propiasRepository.vaciar('u1', citadas);

  assert.deepEqual(resultado, { borradas: 7, conservadas: 2 });
  assert.deepEqual(llamadas[0], [
    'deleteMany',
    { where: { ownerUserId: 'u1', ref: { notIn: citadas } } },
  ]);
  // El recuento es de SUS fuentes: sin el dueño contaría las de otro con esa clave.
  assert.equal(llamadas[1][1].where.ownerUserId, 'u1');
});

// ── La limpieza de su Zotero ────────────────────────────────────────────────

test('lo que sacó de su colección se borra, salvo lo que ya cita', async () => {
  empezar();
  await bibliotecaRepository.borrarLasQueYaNoEstan('u1', '8675309', ['ABCD1234'], ['AR5CCC19E0']);

  const { where } = llamadas[0][1];
  assert.equal(where.ownerUserId, 'u1');
  assert.deepEqual(where.ref, { notIn: ['AR5CCC19E0'] });
  assert.ok(where.sourceRef.startsWith.includes('8675309'), 'solo su cuenta de Zotero');
});

test('sin nada citado, la limpieza de Zotero es la de siempre', async () => {
  empezar();
  await bibliotecaRepository.borrarLasQueYaNoEstan('u1', '8675309', ['ABCD1234']);
  assert.equal(llamadas[0][1].where.ref, undefined);
});
