'use strict';

/**
 * El panel («Mi tesis») recibe de cada proyecto qué se escribe y, en el
 * informe, su ficha. Con eso cambia sus textos; sin ello se ve como siempre.
 *
 * La base, el disco y el catálogo se sustituyen, como en `norma.proyecto`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = { proyectos: [] };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyectos[0] ?? null,
  asegurar: async () => estado.proyectos[0] ?? null,
  nombreDe: async () => 'Alguien',
  listarDeUsuario: async () => estado.proyectos,
  productosConLicencia: async () => [],
  productosConVariasTesis: async () => [],
  nombresDeProducto: async () => new Map(),
  guardarEtapa: async () => ({}),
});
sustituir('../src/modules/projects/project.storage', {
  leerFichaDeDocumento: async () => null,
  leer: async () => null,
  leerPlantilla: async () => null,
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [],
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});

const projectService = require('../src/modules/projects/project.service');

const proyecto = (datos) => ({
  id: `p-${datos.productCode}`,
  ranura: 0,
  nombre: null,
  activadaAt: null,
  tema: null,
  carrera: null,
  universidad: null,
  asesor: null,
  estiloCitas: null,
  idiomaCitas: null,
  plantillaAt: null,
  updatedAt: new Date('2026-09-15T00:00:00Z'),
  stages: [],
  ...datos,
});

test('el informe llega al panel con su tipo y su ficha', async () => {
  estado.proyectos = [
    proyecto({ productCode: 'INFORME_ESTUDIANTIL', fichaInforme: { curso: 'Economía', docente: 'Mg. Rosa Díaz' } }),
  ];
  const [p] = await projectService.deUsuario('u1');
  assert.equal(p.tipo, 'informe');
  assert.deepEqual(p.fichaInforme, { curso: 'Economía', docente: 'Mg. Rosa Díaz' });
});

test('tesis y artículo llegan con su tipo y sin ficha', async () => {
  estado.proyectos = [proyecto({ productCode: 'METODO_DE_TESIS_HUMANIZADOR' })];
  const [tesis] = await projectService.deUsuario('u1');
  assert.equal(tesis.tipo, 'tesis');
  assert.equal(tesis.fichaInforme, null);

  estado.proyectos = [proyecto({ productCode: 'ARTICULO_SCIENTIFICOS' })];
  const [articulo] = await projectService.deUsuario('u1');
  assert.equal(articulo.tipo, 'articulo');
  assert.equal(articulo.fichaInforme, null);
});
