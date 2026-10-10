'use strict';

/**
 * ALICIA lenta. El 9 y el 10-oct-2026 tardaba veinte segundos por búsqueda y
 * casi todas se perdían. Lo que tiene que ser cierto:
 *
 *   · «ALICIA no responde» sigue saliendo como error: el aviso al
 *     administrador es a propósito, es como se entera de que no funciona.
 *   · La misma búsqueda no se le vuelve a pedir a ALICIA durante media hora.
 *   · Pasada la media hora se pide otra vez; si ALICIA no contesta, se enseña
 *     lo guardado. Sin nada guardado, el fallo llega.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const niveles = [];
const anotar = (nivel) => () => niveles.push(nivel);
sustituir('../src/config/logger', {
  debug: anotar('debug'),
  info: anotar('info'),
  warn: anotar('warn'),
  error: anotar('error'),
});
sustituir('../src/modules/references/alicia.client', {
  POR_PAGINA: 20,
  esId: () => true,
  buscar: async () => {
    throw new Error('The operation was aborted due to timeout');
  },
});

const errorHandler = require('../src/middlewares/errorHandler');
const alicia = require('../src/modules/scopus/scopus.alicia');

const { buscarConMemoria } = alicia;

function respuestaFalsa() {
  return {
    codigo: null,
    cuerpo: null,
    set() {
      return this;
    },
    status(codigo) {
      this.codigo = codigo;
      return this;
    },
    json(cuerpo) {
      this.cuerpo = cuerpo;
      return this;
    },
  };
}

test('«ALICIA no responde» es un 503 que sale como error: el aviso se mantiene', async () => {
  let fallo;
  try {
    await alicia.buscar('usuario-1', { consulta: '"sin respuesta"' });
  } catch (e) {
    fallo = e;
  }
  assert.ok(fallo, 'la búsqueda tiene que fallar');

  niveles.length = 0;
  const res = respuestaFalsa();
  errorHandler(fallo, { method: 'POST', originalUrl: '/api/v1/mi-scopus/alicia' }, res, () => {});

  assert.equal(res.codigo, 503);
  assert.match(res.cuerpo.error.message, /ALICIA no responde/);
  assert.deepEqual(niveles, ['error']);
});

test('la misma búsqueda no se le repite a ALICIA durante media hora', async () => {
  let llamadas = 0;
  let reloj = 0;
  const opciones = {
    ahora: () => reloj,
    buscarEnAlicia: async () => ({ total: ++llamadas, fichas: [] }),
  };
  const peticion = { consulta: '"memoria fresca"', pagina: 1, tipos: ['maestria', 'pregrado'] };

  assert.equal((await buscarConMemoria(peticion, opciones)).total, 1);
  reloj += 29 * 60 * 1000;
  // Los mismos tipos en otro orden son la misma búsqueda.
  const otraVez = { ...peticion, tipos: ['pregrado', 'maestria'] };
  assert.equal((await buscarConMemoria(otraVez, opciones)).total, 1);
  assert.equal(llamadas, 1);

  // Otra página sí es otra pregunta.
  assert.equal((await buscarConMemoria({ ...peticion, pagina: 2 }, opciones)).total, 2);

  reloj += 2 * 60 * 1000;
  assert.equal((await buscarConMemoria(peticion, opciones)).total, 3);
});

test('si ALICIA no contesta se enseña lo guardado; sin nada guardado, el fallo llega', async () => {
  let reloj = 0;
  let caida = false;
  const opciones = {
    ahora: () => reloj,
    buscarEnAlicia: async () => {
      if (caida) throw new Error('The operation was aborted due to timeout');
      return { total: 7, fichas: [] };
    },
  };
  const peticion = { consulta: '"memoria vieja"', pagina: 1, tipos: [] };

  await buscarConMemoria(peticion, opciones);
  reloj += 3 * 60 * 60 * 1000;
  caida = true;

  assert.equal((await buscarConMemoria(peticion, opciones)).total, 7);
  await assert.rejects(
    buscarConMemoria({ ...peticion, consulta: '"nunca vista"' }, opciones),
    /aborted due to timeout/,
  );
});
