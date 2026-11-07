'use strict';

/**
 * `verificar_citas` le enseña al autor el resumen de cada fuente que cita.
 *
 * `porClaves` no pedía el resumen a la base, así que la ficha decía «No tenemos
 * su resumen» de TODAS las fuentes, aunque estuvieran completas en su biblioteca
 * (E2E del 7-nov-2026). El .bib tenía el mismo hueco. El Word no lo necesita y
 * sigue sin cargarlo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pedidas = [];
const rutaPrisma = require.resolve('../src/lib/prisma');
require.cache[rutaPrisma] = {
  id: rutaPrisma,
  filename: rutaPrisma,
  loaded: true,
  exports: {
    reference: {
      findMany: async (consulta) => {
        pedidas.push(consulta);
        return [];
      },
    },
  },
};

const repo = require('../src/modules/references/reference.repository');
const verificacion = require('../src/modules/projects/project.verificacion');

test('con conResumen se pide el resumen y la nota; sin él, no', async () => {
  await repo.porClaves(['AR0A1B2C3D'], 'u1', { conResumen: true });
  assert.equal(pedidas.at(-1).select.abstract, true);
  assert.equal(pedidas.at(-1).select.notes, true);

  await repo.porClaves(['AR0A1B2C3D'], 'u1');
  assert.equal(pedidas.at(-1).select.abstract, undefined, 'el Word no carga los resúmenes');
});

test('la ficha que ve el autor enseña el resumen cuando la fuente lo trae', () => {
  const [item] = verificacion.inventario(
    [{ code: 'articulo-fase2-introduccion', titulo: 'Introducción', texto: 'Algo pasa [AR0A1B2C3D].' }],
    new Map([['AR0A1B2C3D', { ref: 'AR0A1B2C3D', authors: 'Liu, X.', year: 2026, title: 'T', abstract: 'Resumen entero.' }]]),
    {},
  );
  const ficha = verificacion.ficha(item, 1);
  assert.match(ficha, /Resumen \(orienta, no sustituye la lectura\): «Resumen entero\.»/);
  assert.doesNotMatch(ficha, /No tenemos su resumen/);
});

test('la ficha enseña el resumen hasta donde suelen estar los resultados (2.000 caracteres)', () => {
  const largo = `${'a'.repeat(1500)} RESULTADOS: el efecto indirecto fue significativo.`;
  const [item] = verificacion.inventario(
    [{ code: 'articulo-fase2-introduccion', titulo: 'Introducción', texto: 'Algo pasa [AR0A1B2C3D].' }],
    new Map([['AR0A1B2C3D', { ref: 'AR0A1B2C3D', authors: 'Zhen, Y.', year: 2026, title: 'T', abstract: largo }]]),
    {},
  );
  assert.match(verificacion.ficha(item, 1), /RESULTADOS: el efecto indirecto fue significativo\./);
});
