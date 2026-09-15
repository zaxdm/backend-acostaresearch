'use strict';

/**
 * La ficha del informe estudiantil: curso, docente, integrantes, entrega y
 * rúbrica.
 *
 * Lo que tiene que ser cierto:
 *
 *   · se valida y se completa por partes, sin borrar lo que ya estaba;
 *   · solo la guarda el producto de informes: tesis y artículo la ignoran;
 *   · el panorama del informe la enseña en lugar del asesor;
 *   · el conector solo ofrece «informe» en guardar_avance a ese producto.
 *
 * La base, el catálogo y el disco se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const INFORME = 'INFORME_ESTUDIANTIL';
const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';

const estado = { proyecto: null, asegurado: null };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async (userId, productCode, cambios) => {
    estado.asegurado = cambios;
    return estado.proyecto ?? { id: 'p1' };
  },
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [
    { code: 'informe-fase0-encargo', displayName: 'Fase 0 — El encargo' },
    { code: 'informe-fase1-fuentes', displayName: 'Fase 1 — Las fuentes' },
  ],
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});
sustituir('../src/modules/projects/project.storage', {
  fechaDeAnalisis: async () => null,
  leer: async () => null,
  leerMaterial: async () => null,
});

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

const ficha = require('../src/modules/projects/project.ficha-informe');
const { guardarAvanceSchema } = require('../src/modules/projects/project.schema');
const projectService = require('../src/modules/projects/project.service');
const { construirServidor } = require('../src/modules/mcp/mcp.tools');

// ── Validar ────────────────────────────────────────────────────────────────

test('la ficha se admite a medias y descarta lo que no conoce', () => {
  const r = guardarAvanceSchema.parse({ informe: { curso: 'Estadística I', inventado: 'x' } });
  assert.deepEqual(r.informe, { curso: 'Estadística I' });
});

test('la fecha de entrega va como AAAA-MM-DD y el tipo es de la lista', () => {
  assert.equal(guardarAvanceSchema.safeParse({ informe: { fechaEntrega: '15/10/2026' } }).success, false);
  assert.equal(guardarAvanceSchema.safeParse({ informe: { tipo: 'monografia' } }).success, false);
  assert.equal(guardarAvanceSchema.safeParse({ informe: { fechaEntrega: '2026-10-15', tipo: 'caso' } }).success, true);
});

test('guardar_avance sin ficha sigue validando igual', () => {
  assert.deepEqual(guardarAvanceSchema.parse({ tema: 'X' }), { tema: 'X' });
});

// ── Fundir ─────────────────────────────────────────────────────────────────

test('lo nuevo se funde con lo que había; los integrantes se sustituyen enteros', () => {
  const antes = { curso: 'Estadística I', integrantes: [{ nombre: 'Ana' }, { nombre: 'Luis' }] };
  const despues = ficha.fusionarFicha(antes, { docente: 'Mg. Rosa Díaz', integrantes: [{ nombre: 'Ana' }] });
  assert.deepEqual(despues, {
    curso: 'Estadística I',
    docente: 'Mg. Rosa Díaz',
    integrantes: [{ nombre: 'Ana' }],
  });
});

test('un docente vacío se guarda: quiere decir que ya se preguntó', () => {
  assert.equal(ficha.fusionarFicha({ curso: 'X' }, { docente: '' }).docente, '');
});

// ── Lo que lee Claude ──────────────────────────────────────────────────────

const AHORA = new Date('2026-09-15T17:00:00Z'); // mediodía en Lima

test('los días hasta la entrega se cuentan en hora de Lima', () => {
  assert.equal(ficha.diasHasta('2026-09-15', AHORA), 0);
  assert.equal(ficha.diasHasta('2026-10-01', AHORA), 16);
  // A las 23:30 de Lima ya es el día 16 en UTC, pero para el estudiante sigue siendo 15.
  assert.equal(ficha.diasHasta('2026-09-16', new Date('2026-09-16T04:30:00Z')), 1);
});

test('la ficha se enseña con curso, docente, integrantes y entrega', () => {
  const lineas = ficha.lineasDeFicha(
    {
      tipo: 'curso',
      curso: 'Estadística I',
      cicloSeccion: 'IV ciclo, B',
      docente: 'Mg. Rosa Díaz',
      integrantes: [{ nombre: 'Ana Ruiz', codigo: 'U2023001' }, { nombre: 'Luis Soto' }],
      fechaEntrega: '2026-10-01',
      rubrica: 'Fuentes confiables; conclusiones por objetivo.',
    },
    { ahora: AHORA },
  );
  assert.deepEqual(lineas, [
    'Tipo: informe académico de curso',
    'Curso: Estadística I · Ciclo y sección: IV ciclo, B',
    'Docente: Mg. Rosa Díaz',
    'Integrantes: Ana Ruiz (U2023001); Luis Soto',
    'Entrega: 2026-10-01 (faltan 16 días).',
  ]);
});

test('la rúbrica solo sale cuando se pide, y el docente sin dato se pregunta una vez', () => {
  const conRubrica = ficha.lineasDeFicha({ rubrica: 'Criterios.' }, { conRubrica: true, ahora: AHORA });
  assert.ok(conRubrica.includes('Rúbrica del docente: Criterios.'));
  assert.match(conRubrica.join('\n'), /Docente: sin dato/);
  assert.doesNotMatch(ficha.lineasDeFicha({ docente: '' }).join('\n'), /Docente/);
});

test('una entrega vencida se dice, y se pregunta por el plazo', () => {
  assert.match(ficha.lineasDeFicha({ fechaEntrega: '2026-09-10', docente: '' }, { ahora: AHORA })[0], /ya pasó hace 5 días/);
});

// ── Guardar ────────────────────────────────────────────────────────────────

test('el informe guarda la ficha fundida con la que ya tenía', async () => {
  estado.proyecto = { id: 'p1', productCode: INFORME, fichaInforme: { curso: 'Estadística I' }, stages: [] };
  await projectService.guardarAvance({ userId: 'u1', productCode: INFORME, informe: { docente: 'Mg. Rosa Díaz' } });
  assert.deepEqual(estado.asegurado.fichaInforme, { curso: 'Estadística I', docente: 'Mg. Rosa Díaz' });
});

test('una tesis no guarda ficha aunque le llegue', async () => {
  estado.proyecto = { id: 'p2', productCode: TESIS, stages: [] };
  await projectService.guardarAvance({ userId: 'u1', productCode: TESIS, informe: { curso: 'X' } });
  assert.equal(estado.asegurado.fichaInforme, undefined);
});

// ── El panorama ────────────────────────────────────────────────────────────

test('el panorama del informe enseña la ficha y no pide asesor', async () => {
  estado.proyecto = {
    id: 'p1',
    productCode: INFORME,
    tema: 'La informalidad laboral en Lima',
    carrera: null,
    universidad: 'Tecsup',
    asesor: null,
    fichaInforme: { tipo: 'curso', curso: 'Economía', docente: 'Mg. Rosa Díaz' },
    stages: [],
  };
  const texto = await projectService.resumen('u1', INFORME);
  assert.match(texto, /Tipo: informe académico de curso/);
  assert.match(texto, /Docente: Mg\. Rosa Díaz/);
  assert.doesNotMatch(texto, /Asesor/);
});

test('un informe con solo la ficha ya tiene panorama', async () => {
  estado.proyecto = { id: 'p1', productCode: INFORME, fichaInforme: { curso: 'Economía' }, stages: [] };
  assert.notEqual(await projectService.resumen('u1', INFORME), null);
});

// ── El conector ────────────────────────────────────────────────────────────

function esquemaDeGuardarAvance(productCode) {
  registradas = new Map();
  construirServidor({ productCode });
  return registradas.get('guardar_avance').inputSchema['~standard'].jsonSchema.input();
}

test('guardar_avance ofrece la ficha al informe y no a tesis ni artículo', () => {
  assert.ok(esquemaDeGuardarAvance(INFORME).properties.informe);
  assert.equal(esquemaDeGuardarAvance(TESIS).properties.informe, undefined);
  assert.equal(esquemaDeGuardarAvance('ARTICULO_SCIENTIFICOS').properties.informe, undefined);
});
