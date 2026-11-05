'use strict';

/**
 * «Mis fuentes» y «Mis documentos» de AcostaIA (4-nov-2026).
 *
 * Lo que se prueba: que se lee del titular espejo, que solo salen los productos
 * con licencia activa, que de cada producto sale el proyecto activo con sus
 * fases en el orden del catálogo, y que el enlace de descarga no se da para un
 * producto ajeno. La base y los servicios de proyectos se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const estado = {
  usuarios: [{ id: 'espejo-1', acostaiaId: 'usr_12345678' }],
  licencias: [
    { userId: 'espejo-1', productCode: 'TESIS', status: 'ACTIVE' },
    { userId: 'espejo-1', productCode: 'VIEJO', status: 'REVOKED' },
  ],
  pedidas: [],
};

sustituir('../src/lib/prisma', {
  user: {
    findUnique: async ({ where }) => estado.usuarios.find((u) => u.acostaiaId === where.acostaiaId) ?? null,
  },
  license: {
    findMany: async ({ where }) =>
      estado.licencias.filter((l) => l.userId === where.userId && l.status === where.status),
  },
});

sustituir('../src/modules/references/propias.service', {
  biblioteca: async (userId, opciones) => {
    estado.pedidas.push({ userId, ...opciones });
    return {
      total: 2,
      deZotero: 1,
      deMendeley: 0,
      subidas: 1,
      zotero: { coleccion: 'Tesis', ultima: null, trayendo: false, error: null },
      mendeley: null,
      origen: opciones.origen,
      pagina: opciones.pagina,
      paginas: 1,
      enElFiltro: 2,
      fuentes: [
        { ref: 'AR12345678', title: 'Uso de IA', authors: 'Quispe, A.', year: 2024, origin: 'ZOTERO' },
        { ref: 'AR87654321', title: 'Rendimiento', authors: 'Lopez, B.', year: 2023, origin: 'SCOPUS' },
      ],
    };
  },
});

const ahora = Date.now();
sustituir('../src/modules/projects/project.repository', {
  listarDeUsuario: async () => [
    {
      productCode: 'TESIS', nombre: null, tema: 'IA en universitarios', universidad: 'UCV',
      activadaAt: new Date(ahora - 1000), updatedAt: new Date(ahora),
      stages: [{ skillCode: 'fase1', estado: 'LISTO', palabras: 800 }],
    },
    {
      productCode: 'TESIS', nombre: 'Otra', tema: 'Vieja', universidad: null,
      activadaAt: new Date(ahora - 99_000), updatedAt: new Date(ahora - 99_000), stages: [],
    },
    {
      productCode: 'VIEJO', nombre: null, tema: 'No debe salir', universidad: null,
      activadaAt: new Date(ahora), updatedAt: new Date(ahora), stages: [],
    },
  ],
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [
    { code: 'fase1', displayName: 'Tema y delimitación' },
    { code: 'fase2', displayName: 'Problema y objetivos' },
  ],
});
sustituir('../src/modules/projects/project.service', {
  enlaceDelWord: async (userId, productCode) => ({ url: `https://api/descarga/${userId}-${productCode}`, minutos: 30 }),
});
sustituir('../src/modules/projects/documento.service', { enlace: async () => null });

const datos = require('../src/modules/acostaia/acostaia.datos');

test('«Mis fuentes» lee la biblioteca del titular espejo y la devuelve en español', async () => {
  const r = await datos.fuentes({ acostaiaId: 'usr_12345678', pagina: 2, origen: 'zotero' });
  assert.deepEqual(estado.pedidas.at(-1), { userId: 'espejo-1', pagina: 2, origen: 'zotero' });
  assert.equal(r.total, 2);
  assert.deepEqual(r.fuentes[0], { clave: 'AR12345678', titulo: 'Uso de IA', autores: 'Quispe, A.', anio: 2024, origen: 'ZOTERO' });
});

test('sin titular espejo (aún no abrió ningún chat) no hay nada, sin error', async () => {
  assert.deepEqual((await datos.fuentes({ acostaiaId: 'usr_nadie000' })).fuentes, []);
  assert.deepEqual(await datos.documentos({ acostaiaId: 'usr_nadie000' }), []);
  assert.equal(await datos.enlace({ acostaiaId: 'usr_nadie000', productCode: 'TESIS', que: 'word' }), null);
});

test('«Mis documentos»: solo productos con licencia activa, el proyecto activo y sus fases en orden', async () => {
  const r = await datos.documentos({ acostaiaId: 'usr_12345678' });
  assert.equal(r.length, 1, 'el producto revocado no sale');
  const [tesis] = r;
  assert.equal(tesis.tema, 'IA en universitarios', 'el activado más reciente');
  assert.deepEqual(
    tesis.fases.map((f) => [f.nombre, f.estado, f.palabras]),
    [['Tema y delimitación', 'LISTO', 800], ['Problema y objetivos', 'PENDIENTE', 0]],
  );
  assert.equal(tesis.palabras, 800);
  assert.equal(tesis.hayWord, true);
  assert.equal(tesis.haySubido, false);
  assert.equal('url' in tesis, false, 'la lista no lleva enlaces: se piden al pulsar');
});

test('el enlace de descarga solo se da para un producto suyo y activo', async () => {
  const bueno = await datos.enlace({ acostaiaId: 'usr_12345678', productCode: 'TESIS', que: 'word' });
  assert.equal(bueno.url, 'https://api/descarga/espejo-1-TESIS');
  assert.equal(await datos.enlace({ acostaiaId: 'usr_12345678', productCode: 'VIEJO', que: 'word' }), null);
  assert.equal(await datos.enlace({ acostaiaId: 'usr_12345678', productCode: 'TESIS', que: 'documento' }), null);
});
