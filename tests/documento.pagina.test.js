'use strict';

/**
 * La página de subir el documento desde el enlace de Claude.
 *
 * Como la del formato (ver `formato.pagina`): con un enlace bueno la ruta
 * responde 200 con lo que hay subido, y no un 500 por algo sin importar; y con
 * uno que no vale, la subida se corta ANTES de leer un archivo de hasta 40 MB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const TESIS = 'METODO_DE_TESIS_HUMANIZADOR';
const estado = { proyecto: null };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async () => estado.proyecto,
  productosConLicencia: async () => [TESIS],
  listarDeUsuario: async () => [],
});

const documento = require('../src/modules/projects/project.subida-documento');
const rutas = require('../src/modules/projects/project.routes');

const tokenDe = (url) => url.split('/').pop();

function pilaDe(metodo, ruta) {
  const capa = rutas.stack.find((c) => c.route?.path === ruta && c.route.methods[metodo]);
  assert.ok(capa, `no existe ${metodo.toUpperCase()} ${ruta}`);
  return capa.route.stack;
}

function llamar(manejador, token) {
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
    const req = { params: { token }, get: () => undefined };
    manejador(req, res, (error) => resolve({ error, req }));
  });
}

test('con un enlace bueno la página recibe lo que hay subido, no un 500', async () => {
  estado.proyecto = null;
  const { url } = documento.enlace({ userId: 'u1', productCode: TESIS });
  const pila = pilaDe('get', '/documento-enlace/:token');
  const { codigo, cuerpo, error } = await llamar(pila[pila.length - 1].handle, tokenDe(url));

  assert.equal(error, undefined);
  assert.equal(codigo, 200);
  assert.equal(cuerpo.data.documento, null);
  assert.ok(new Date(cuerpo.data.caduca) > new Date());
});

test('un enlace que no vale da 404 al abrir la página y corta la subida antes de leer el archivo', async () => {
  const get = pilaDe('get', '/documento-enlace/:token');
  const abrir = await llamar(get[get.length - 1].handle, 'no-es-un-token');
  assert.equal(abrir.error?.statusCode ?? abrir.error?.status, 404);

  // El primer paso del POST es el enlace; el cuerpo se lee en el segundo.
  const post = pilaDe('post', '/documento-enlace/:token');
  const subir = await llamar(post[0].handle, 'no-es-un-token');
  assert.equal(subir.error?.statusCode ?? subir.error?.status, 404);

  const { url } = documento.enlace({ userId: 'u1', productCode: TESIS });
  const bueno = await llamar(post[0].handle, tokenDe(url));
  assert.equal(bueno.error, undefined);
  assert.equal(bueno.req.enlaceDeDocumento.userId, 'u1');
});
