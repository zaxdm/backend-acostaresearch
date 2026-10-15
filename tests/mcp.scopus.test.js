'use strict';

/**
 * Scopus desde el conector: «buscar_en_scopus» y «guardar_de_scopus».
 *
 * Existen porque el tesista pedía «busca en Scopus» y Claude contestaba «no
 * tengo acceso a Scopus», con el buscador abierto en su perfil. Se prueba que
 * llaman al mismo `scopus.service` que la web, que lo que devuelven sirve para
 * guardar (el EID), que un fallo de Scopus no se vende como éxito y que cada
 * persona tiene el mismo tope que en la web.
 *
 * Sin base ni red: se sustituyen el servicio de Scopus y la licencia, y se
 * llama a los handlers de verdad a través de un `McpServer` que solo los apunta.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// La configuración está congelada: se sustituye por una copia con Scopus
// encendido, que es cuando se registran estas dos herramientas.
sustituir('../src/config/env', { ...require('../src/config/env'), scopusApiEnabled: true });

const { AppError } = require('../src/shared/errors/AppError');

const scopus = { busquedas: [], importaciones: [], fallo: null };
sustituir('../src/modules/scopus/scopus.service', {
  buscar: async (userId, opciones) => {
    scopus.busquedas.push({ userId, ...opciones });
    if (scopus.fallo) throw scopus.fallo;
    return {
      total: 120,
      pagina: 1,
      paginas: 5,
      desde: 1,
      resultados: [
        {
          eid: '2-s2.0-85100000001',
          titulo: 'Generative AI and critical thinking',
          autores: 'Smith, J.; Lee, K.',
          anio: 2024,
          revista: 'Computers & Education',
          volumen: '210',
          numero: null,
          paginas: '104-120',
          doi: '10.1016/j.compedu.2024.1',
          citas: 87,
          accesoAbierto: true,
          yaLaTienes: false,
        },
        {
          eid: '2-s2.0-85100000002',
          titulo: 'Students and chatbots',
          autores: 'Pérez, A.',
          anio: 2023,
          revista: 'Educación XX1',
          citas: 12,
          accesoAbierto: false,
          yaLaTienes: true,
        },
      ],
    };
  },
  importar: async (userId, { eids }) => {
    scopus.importaciones.push({ userId, eids });
    if (scopus.fallo) throw scopus.fallo;
    return { pedidas: eids.length, guardadas: eids.length, repetidas: 0, noEncontradas: 0, sinResumen: 1, total: 57 };
  },
});

const cupo = { liberadas: 0 };
sustituir('../src/modules/licensing/license.service', {
  recordUsage: async () => {},
  reserveLimits: async () => ({ permitido: true }),
  releaseLimits: async () => {
    cupo.liberadas += 1;
  },
});

const ruta = require.resolve('@modelcontextprotocol/server');
const real = require('@modelcontextprotocol/server');
const herramientas = new Map();
const configuraciones = new Map();
require.cache[ruta] = {
  id: ruta,
  filename: ruta,
  loaded: true,
  exports: {
    fromJsonSchema: real.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config, handler) {
        herramientas.set(nombre, handler);
        configuraciones.set(nombre, config);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');

/** Cada prueba con su propia persona: el tope de 30 es por usuario. */
const servidorDe = (userId) => {
  herramientas.clear();
  construirServidor({ id: `L-${userId}`, userId, user: { id: userId }, productCode: 'METODO_DE_TESIS_HUMANIZADOR' });
  return async (nombre, argumentos = {}) => (await herramientas.get(nombre)(argumentos)).content[0].text;
};

test('la descripción le dice que SÍ tiene acceso a Scopus', () => {
  servidorDe('U0');
  const d = configuraciones.get('buscar_en_scopus').description;
  assert.match(d, /SÍ TIENES ACCESO A SCOPUS/);
  assert.match(d, /NUNCA le digas que no puedes entrar a Scopus/);
  assert.match(d, /guardar_de_scopus/);
  assert.match(configuraciones.get('guardar_de_scopus').description, /Añadir a mis fuentes/);
});

test('buscar_en_scopus usa el buscador de la web y enseña el EID para guardar', async () => {
  const llamar = servidorDe('U1');
  scopus.busquedas = [];
  scopus.fallo = null;

  const t = await llamar('buscar_en_scopus', { ecuacion: 'TITLE-ABS-KEY("generative AI")' });

  assert.deepEqual(scopus.busquedas, [
    { userId: 'U1', ecuacion: 'TITLE-ABS-KEY("generative AI")', pagina: undefined, orden: undefined },
  ]);
  assert.match(t, /Scopus: 120 resultados/);
  assert.match(t, /1\. Smith, J\.; Lee, K\. \(2024\)\. Generative AI and critical thinking/);
  assert.match(t, /Computers & Education, 210, 104-120/);
  assert.match(t, /EID: 2-s2\.0-85100000001 · DOI: 10\.1016\/j\.compedu\.2024\.1/);
  assert.match(t, /citado 87 veces · acceso abierto/);
  assert.match(t, /YA LA TIENE GUARDADA/);
  assert.match(t, /pide la página 2/);
  assert.match(t, /TODAVÍA NO SE PUEDEN CITAR[\s\S]*guardar_de_scopus/);
});

test('guardar_de_scopus importa por EID, como el botón de la web', async () => {
  const llamar = servidorDe('U2');
  scopus.importaciones = [];
  scopus.fallo = null;

  const t = await llamar('guardar_de_scopus', { eids: ['2-s2.0-85100000001'] });

  assert.deepEqual(scopus.importaciones, [{ userId: 'U2', eids: ['2-s2.0-85100000001'] }]);
  assert.match(t, /1 fuentes nuevas/);
  assert.match(t, /sin resumen/);
  assert.match(t, /Ahora tiene 57 fuentes propias/);
  assert.match(t, /buscar_fuentes/);
});

test('si Scopus falla, se dice lo que pasó y no se cobra', async () => {
  const llamar = servidorDe('U3');
  scopus.fallo = new AppError('Scopus limitó las consultas por ahora.', { statusCode: 429 });
  cupo.liberadas = 0;

  const t = await llamar('buscar_en_scopus', { ecuacion: 'TITLE-ABS-KEY(x)' });
  assert.match(t, /Scopus limitó las consultas/);
  assert.match(t, /buscar_fuentes/);
  assert.equal(cupo.liberadas, 1);

  const g = await llamar('guardar_de_scopus', { eids: ['2-s2.0-1'] });
  assert.match(g, /^No se guardó nada: Scopus limitó/);
  assert.match(g, /no des estas fuentes por guardadas/);
  scopus.fallo = null;
});

test('un fallo que no es nuestro no enseña su mensaje interno', async () => {
  const llamar = servidorDe('U4');
  scopus.fallo = new Error('ECONNRESET 10.0.0.1');

  const t = await llamar('buscar_en_scopus', { ecuacion: 'TITLE-ABS-KEY(x)' });
  assert.doesNotMatch(t, /ECONNRESET/);
  assert.match(t, /Scopus no contestó bien/);
  scopus.fallo = null;
});

test('treinta idas a Scopus cada diez minutos por persona, buscar y guardar juntos', async () => {
  const llamar = servidorDe('U5');
  scopus.busquedas = [];

  for (let i = 0; i < 29; i += 1) await llamar('buscar_en_scopus', { ecuacion: 'TITLE-ABS-KEY(x)' });
  await llamar('guardar_de_scopus', { eids: ['2-s2.0-1'] });
  assert.equal(scopus.busquedas.length, 29);

  const t = await llamar('buscar_en_scopus', { ecuacion: 'TITLE-ABS-KEY(x)' });
  assert.match(t, /muchas veces seguidas/);
  assert.equal(scopus.busquedas.length, 29, 'la 31.ª no llega a Elsevier');

  // Otra persona no hereda el tope.
  const otra = servidorDe('U6');
  assert.match(await otra('buscar_en_scopus', { ecuacion: 'TITLE-ABS-KEY(x)' }), /Scopus: 120/);
});
