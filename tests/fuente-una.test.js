'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const propiasRepository = require('../src/modules/references/propias.repository');
const propiasService = require('../src/modules/references/propias.service');
const projectRepository = require('../src/modules/projects/project.repository');
const almacen = require('../src/modules/projects/project.storage');

/**
 * Corregir o borrar UNA fuente de «Mis fuentes» (22-oct-2026): un cliente
 * escribió mal el nombre de dos fuentes sin DOI y solo podía borrarlas todas.
 */

const fila = (extra = {}) => ({
  id: 'id-1',
  ref: 'AR1A2B3C4D',
  origin: 'SCOPUS',
  sourceRef: 'titulo:gestiondelconocimientoenmypes',
  title: 'Gestion del conocimiento en mypes',
  authors: 'Pérez, J.',
  year: 2020,
  source: 'UNT',
  itemType: 'thesis',
  abstract: null,
  tags: '',
  ...extra,
});

function sinCitas(t) {
  t.mock.method(projectRepository, 'listarDeUsuario', async () => []);
}

test('corregir cambia la ficha de la misma fila y recalcula su identidad por título', async (t) => {
  t.mock.method(propiasRepository, 'unaPorClave', async () => fila());
  t.mock.method(propiasRepository, 'otraConEsaIdentidad', async () => false);
  const corregir = t.mock.method(propiasRepository, 'corregir', async () => ({}));

  await propiasService.corregir({
    userId: 'u1',
    clave: 'AR1A2B3C4D',
    ficha: { titulo: 'Gestión del conocimiento en las mypes de Trujillo', autores: 'Pérez ; López', anio: 2021, fuente: 'UNT', tipo: 'tesis' },
  });

  const [id, datos] = corregir.mock.calls[0].arguments;
  assert.equal(id, 'id-1');
  assert.equal(datos.title, 'Gestión del conocimiento en las mypes de Trujillo');
  assert.equal(datos.authors, 'Pérez; López');
  assert.equal(datos.year, 2021);
  assert.equal(datos.itemType, 'thesis');
  assert.match(datos.sourceRef, /^titulo:gestiondelconocimientoenlasmypesdetrujillo/);
  assert.match(datos.busqueda, /trujillo/);
});

test('una fuente con DOI no se corrige a mano', async (t) => {
  t.mock.method(propiasRepository, 'unaPorClave', async () => fila({ sourceRef: 'doi:10.1/x', doi: '10.1/x' }));
  const corregir = t.mock.method(propiasRepository, 'corregir', async () => ({}));

  await assert.rejects(
    propiasService.corregir({ userId: 'u1', clave: 'AR1A2B3C4D', ficha: { titulo: 'Otro título largo' } }),
    /tiene DOI/,
  );
  assert.equal(corregir.mock.callCount(), 0);
});

test('corregir rechaza un título que ya tiene otra fuente suya', async (t) => {
  t.mock.method(propiasRepository, 'unaPorClave', async () => fila());
  t.mock.method(propiasRepository, 'otraConEsaIdentidad', async () => true);
  const corregir = t.mock.method(propiasRepository, 'corregir', async () => ({}));

  await assert.rejects(
    propiasService.corregir({ userId: 'u1', clave: 'AR1A2B3C4D', ficha: { titulo: 'Un título repetido' } }),
    (error) => error.statusCode === 409,
  );
  assert.equal(corregir.mock.callCount(), 0);
});

test('lo de su Zotero o su Mendeley no se corrige ni se borra aquí', async (t) => {
  t.mock.method(propiasRepository, 'unaPorClave', async () => fila({ origin: 'ZOTERO' }));
  const borrar = t.mock.method(propiasRepository, 'borrarUna', async () => 1);
  sinCitas(t);

  await assert.rejects(
    propiasService.corregir({ userId: 'u1', clave: 'AR1A2B3C4D', ficha: { titulo: 'Título nuevo' } }),
    /tu Zotero/,
  );
  await assert.rejects(propiasService.borrarUna({ userId: 'u1', clave: 'AR1A2B3C4D' }), /tu Zotero/);
  assert.equal(borrar.mock.callCount(), 0);
});

test('una clave que no es suya da 404', async (t) => {
  t.mock.method(propiasRepository, 'unaPorClave', async () => null);
  await assert.rejects(
    propiasService.borrarUna({ userId: 'u1', clave: 'AR00000000' }),
    (error) => error.statusCode === 404,
  );
});

test('borrar una fuente sin citar la borra; citada, se queda', async (t) => {
  t.mock.method(propiasRepository, 'unaPorClave', async () => fila());
  const borrar = t.mock.method(propiasRepository, 'borrarUna', async () => 1);

  sinCitas(t);
  await propiasService.borrarUna({ userId: 'u1', clave: 'AR1A2B3C4D' });
  assert.deepEqual(borrar.mock.calls[0].arguments, ['u1', 'id-1']);

  projectRepository.listarDeUsuario.mock.mockImplementation(async () => [
    { id: 'p1', stages: [{ skillCode: 'fase-2', palabras: 100 }] },
  ]);
  t.mock.method(almacen, 'leer', async () => 'Como señala Pérez [AR1A2B3C4D], el conocimiento…');

  await assert.rejects(
    propiasService.borrarUna({ userId: 'u1', clave: 'AR1A2B3C4D' }),
    /citas en tus capítulos/,
  );
  assert.equal(borrar.mock.callCount(), 1);
});
