'use strict';

/**
 * La página de subir el formato, antes de subir nada.
 *
 * El enlace ya tenía pruebas (ver `formato.enlace`), pero la ruta que abre la
 * página no tenía ninguna, y por eso se desplegó un `perfilDe` sin importar:
 * el token valía, la página pedía el estado y la API devolvía 500, así que el
 * tesista leía «este enlace ya no vale» con un enlace recién hecho.
 *
 * Lo que tiene que ser cierto:
 *
 *   · con un enlace bueno la ruta responde 200 y dice cuándo caduca, qué
 *     formato hay puesto y de qué tipo de trabajo se trata;
 *   · el tipo sale del método, para que a un informe de curso no le hable de
 *     su tesis;
 *   · un enlace que no vale sigue dando 404 y no toca la base.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';
const INFORME = 'INFORME_PRUEBA01';

const estado = { proyecto: null, buscados: [] };

sustituir('../src/modules/projects/project.repository', {
  buscar: async (userId, productCode) => {
    estado.buscados.push({ userId, productCode });
    return estado.proyecto;
  },
  asegurar: async () => estado.proyecto,
  productosConLicencia: async () => [TESIS, INFORME],
  listarDeUsuario: async () => [],
});

const formato = require('../src/modules/projects/project.subida-formato');
const rutas = require('../src/modules/projects/project.routes');

const tokenDe = (url) => url.split('/').pop();

/** El manejador de la ruta, sacado del router como lo llamaría Express. */
function manejadorDe(metodo, ruta) {
  const capa = rutas.stack.find((c) => c.route?.path === ruta && c.route.methods[metodo]);
  assert.ok(capa, `no existe ${metodo.toUpperCase()} ${ruta}`);
  const pila = capa.route.stack;
  return pila[pila.length - 1].handle;
}

/** Llama a la ruta y devuelve lo que respondió, o el error que mandó al errorHandler. */
function pedir(token) {
  const manejador = manejadorDe('get', '/formato/:token');
  return new Promise((resolve) => {
    const res = {
      status(codigo) {
        this.codigo = codigo;
        return this;
      },
      json(cuerpo) {
        resolve({ codigo: this.codigo ?? 200, cuerpo });
        return this;
      },
    };
    manejador({ params: { token }, get: () => undefined }, res, (error) => resolve({ error }));
  });
}

test('con un enlace bueno la página recibe el estado del formato, no un 500', async () => {
  estado.proyecto = {
    id: 'p1',
    plantillaAt: new Date('2026-09-15T10:00:00.000Z'),
    plantillaNombre: 'Formato UPN.docx',
    stages: [],
  };
  estado.buscados = [];

  const { url } = formato.enlace({ userId: 'u1', productCode: TESIS });
  const { codigo, cuerpo, error } = await pedir(tokenDe(url));

  assert.equal(error, undefined);
  assert.equal(codigo, 200);
  assert.equal(cuerpo.success, true);
  assert.equal(cuerpo.data.tipo, 'tesis');
  assert.equal(cuerpo.data.formato.nombre, 'Formato UPN.docx');
  assert.ok(new Date(cuerpo.data.caduca) > new Date());
  // El proyecto que se mira es el del enlace, no uno que venga por la dirección.
  assert.deepEqual(estado.buscados, [{ userId: 'u1', productCode: TESIS }]);
});

test('sin formato puesto la página lo dice, y en el informe el tipo es informe', async () => {
  estado.proyecto = { id: 'p1', plantillaAt: null, stages: [] };

  const { url } = formato.enlace({ userId: 'u1', productCode: INFORME });
  const { codigo, cuerpo, error } = await pedir(tokenDe(url));

  assert.equal(error, undefined);
  assert.equal(codigo, 200);
  assert.equal(cuerpo.data.formato, null);
  assert.equal(cuerpo.data.tipo, 'informe');
});

test('un enlace retocado da 404 y no llega a preguntarle a la base', async () => {
  estado.proyecto = { id: 'p1', plantillaAt: null, stages: [] };
  estado.buscados = [];

  const { error, codigo } = await pedir('no.es.un.enlace');

  assert.equal(codigo, undefined);
  assert.equal(error?.statusCode ?? error?.status, 404);
  assert.deepEqual(estado.buscados, []);
});

// ── Vencido o alterado ──────────────────────────────────────────────────────
//
// Con ChatGPT el estudiante leía «ya no vale» y no se sabía si el asistente le
// había repetido un enlace viejo o se lo había estropeado al copiarlo.

const jwt = require('jsonwebtoken');
const env = require('../src/config/env');

const vencidoDe = (secreto = env.JWT_ACCESS_SECRET) =>
  jwt.sign({ typ: 'subir-formato', pc: TESIS, exp: Math.floor(Date.now() / 1000) - 60 }, secreto, {
    subject: 'u1',
    issuer: env.JWT_ISSUER,
    audience: `${env.JWT_AUDIENCE}:subir-formato`,
  });

test('un enlace auténtico que pasó su media hora dice que venció y que pida otro', async () => {
  const { error } = await pedir(vencidoDe());

  assert.equal(error?.statusCode ?? error?.status, 404);
  assert.match(error.message, /venció/);
  assert.match(error.message, /pide uno nuevo/);
  assert.doesNotMatch(error.message, /incompleto/);
});

test('un enlace con un carácter cambiado dice que llegó incompleto, no que venció', async () => {
  const bueno = tokenDe(formato.enlace({ userId: 'u1', productCode: TESIS }).url);
  // Un carácter del medio de la firma: el último lleva bits de relleno.
  const i = bueno.length - 20;
  const { error } = await pedir(bueno.slice(0, i) + (bueno[i] === 'A' ? 'B' : 'A') + bueno.slice(i + 1));

  assert.equal(error?.statusCode ?? error?.status, 404);
  assert.match(error.message, /incompleto/);
  assert.doesNotMatch(error.message, /venció/);
});

test('un token vencido pero con otra firma no revela que venció', async () => {
  const { error } = await pedir(vencidoDe('otro-secreto-que-no-es-el-del-servidor'));

  assert.match(error.message, /incompleto/);
  assert.doesNotMatch(error.message, /venció/);
});

test('los mensajes del enlace no nombran a ningún asistente', async () => {
  for (const token of [vencidoDe(), 'no.es.un.enlace']) {
    const { error } = await pedir(token);
    assert.doesNotMatch(error.message, /Claude|ChatGPT|Grok/);
  }
});
