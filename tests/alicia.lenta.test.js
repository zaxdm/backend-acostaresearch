'use strict';

/**
 * ALICIA lenta o caída. El 9 y el 10-oct-2026 pasó de tardar veinte segundos
 * por búsqueda a no contestar en toda la mañana. Lo que tiene que ser cierto:
 *
 *   · La misma búsqueda no se le vuelve a pedir a ALICIA durante media hora.
 *   · Si ALICIA no contesta, se enseña lo que ya había contestado; si no hay
 *     nada, se busca en LA Referencia y la respuesta dice de dónde viene.
 *   · Tras un fallo no se hace esperar a nadie más: se va al respaldo y ALICIA
 *     se sondea por detrás cada tres minutos. Cuando contesta, se vuelve a ella.
 *   · Cada fallo de ALICIA se anota como ERROR aunque el tesista vea
 *     resultados: el aviso al administrador es a propósito.
 *   · LA Referencia no tiene pregrado: pedir solo pregrado con ALICIA caída es
 *     un «no responde» que lo explica, no una lista vacía.
 *   · «Añadir a mis fuentes» usa las fichas ya enseñadas y no repite una tesis
 *     que el tesista guardó desde el otro catálogo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const registro = [];
const anotar = (nivel) => (...args) =>
  registro.push({ nivel, msg: args.find((a) => typeof a === 'string') });
sustituir('../src/config/logger', {
  debug: anotar('debug'),
  info: anotar('info'),
  warn: anotar('warn'),
  error: anotar('error'),
});

const base = { hashes: [], guardadas: [] };
sustituir('../src/modules/references/propias.repository', {
  TOPE_POR_USUARIO: 2000,
  contar: async () => 10,
  hashesDeRepositorioQueTiene: async (_userId, hashes) => hashes.filter((h) => base.hashes.includes(h)),
  guardarLote: async (_userId, filas) => {
    base.guardadas.push(...filas.map((f) => f.sourceRef));
    return { guardadas: filas.length, repetidas: 0 };
  },
});

const errorHandler = require('../src/middlewares/errorHandler');
const alicia = require('../src/modules/scopus/scopus.alicia');

const { buscarEnPeruanas } = alicia;

const H1 = '820c408978406207d0f35805795f9530';
const H2 = 'aa4fa0b87ea1772686481325040be247';
const ficha = (id, titulo = 'Pensamiento crítico') => ({
  id,
  title: titulo,
  authors: 'Pérez, Ana',
  year: 2022,
  source: 'Universidad X',
  universidad: 'Universidad X',
  formato: 'masterThesis',
  tipo: 'Tesis de maestría',
  itemType: 'masterThesis',
  asesor: null,
  url: 'https://repositorio.x.edu.pe/1',
  abstract: 'Resumen',
  tags: '',
});

const TIMEOUT = new Error('The operation was aborted due to timeout');
const tick = () => new Promise((listo) => setImmediate(listo));

/** Un entorno con reloj y con los dos catálogos de mentira. */
function entorno() {
  const e = {
    reloj: 0,
    aliciaCaida: false,
    llamadasAlicia: 0,
    llamadasRespaldo: [],
  };
  e.opciones = {
    ahora: () => e.reloj,
    enAlicia: async () => {
      e.llamadasAlicia += 1;
      if (e.aliciaCaida) throw TIMEOUT;
      return { total: 100 + e.llamadasAlicia, fichas: [ficha(`UPAO_${H1}`)] };
    },
    enRespaldo: async (peticion) => {
      e.llamadasRespaldo.push(peticion);
      return { total: 7, fichas: [ficha(`lareferencia:PE_${H2}`)] };
    },
  };
  return e;
}

test.beforeEach(() => {
  alicia.reiniciar();
  registro.length = 0;
  base.hashes = [];
  base.guardadas = [];
});

test('la misma búsqueda no se le repite a ALICIA durante media hora', async () => {
  const e = entorno();
  const peticion = { consulta: '"memoria"', pagina: 1, tipos: ['maestria', 'doctorado'] };

  const primera = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(primera.fuente, 'alicia');
  assert.equal(primera.total, 101);

  e.reloj += 29 * 60 * 1000;
  // Los mismos tipos en otro orden son la misma búsqueda.
  const otraVez = await buscarEnPeruanas({ ...peticion, tipos: ['doctorado', 'maestria'] }, e.opciones);
  assert.equal(otraVez.total, 101);
  assert.equal(e.llamadasAlicia, 1);

  // Otra página sí es otra pregunta, y pasada la media hora se vuelve a pedir.
  assert.equal((await buscarEnPeruanas({ ...peticion, pagina: 2 }, e.opciones)).total, 102);
  e.reloj += 2 * 60 * 1000;
  assert.equal((await buscarEnPeruanas(peticion, e.opciones)).total, 103);
});

test('ALICIA no contesta: se busca en LA Referencia, y queda anotado como error', async () => {
  const e = entorno();
  e.aliciaCaida = true;

  const r = await buscarEnPeruanas({ consulta: '"sin alicia"', pagina: 1, tipos: [] }, e.opciones);

  assert.equal(r.fuente, 'lareferencia');
  assert.equal(r.total, 7);
  assert.deepEqual(
    registro.filter((l) => l.nivel === 'error').map((l) => l.msg),
    ['ALICIA no responde: se busca en LA Referencia'],
  );
});

test('lo que ALICIA contestó antes gana al respaldo, por viejo que sea', async () => {
  const e = entorno();
  const peticion = { consulta: '"vieja"', pagina: 1, tipos: [] };

  await buscarEnPeruanas(peticion, e.opciones);
  e.reloj += 3 * 60 * 60 * 1000;
  e.aliciaCaida = true;

  const r = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(r.fuente, 'alicia');
  assert.equal(r.total, 101);
  assert.equal(e.llamadasRespaldo.length, 0);
});

test('tras un fallo nadie más espera a ALICIA; se la sondea cada tres minutos y se vuelve a ella', async () => {
  const e = entorno();
  e.aliciaCaida = true;

  await buscarEnPeruanas({ consulta: '"a"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(e.llamadasAlicia, 1);

  // Un minuto después: derecho al respaldo, sin preguntarle a ALICIA.
  e.reloj += 60 * 1000;
  assert.equal((await buscarEnPeruanas({ consulta: '"b"', pagina: 1, tipos: [] }, e.opciones)).fuente, 'lareferencia');
  assert.equal(e.llamadasAlicia, 1);

  // A los tres minutos se la sondea, pero esta búsqueda no espera el resultado.
  e.reloj += 3 * 60 * 1000;
  const c = await buscarEnPeruanas({ consulta: '"c"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(c.fuente, 'lareferencia');
  assert.equal(e.llamadasAlicia, 2);
  await tick();
  assert.equal(registro.filter((l) => l.nivel === 'error').length, 2, 'el sondeo fallido también avisa');

  // ALICIA vuelve: el siguiente sondeo lo descubre y la búsqueda de después ya es suya.
  e.aliciaCaida = false;
  e.reloj += 3 * 60 * 1000;
  assert.equal((await buscarEnPeruanas({ consulta: '"d"', pagina: 1, tipos: [] }, e.opciones)).fuente, 'lareferencia');
  await tick();
  assert.ok(registro.some((l) => l.msg === 'ALICIA volvió a responder'));

  const despues = await buscarEnPeruanas({ consulta: '"e"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(despues.fuente, 'alicia');
  // Y lo que trajo el sondeo quedó guardado para quien lo pidió.
  assert.equal((await buscarEnPeruanas({ consulta: '"d"', pagina: 1, tipos: [] }, e.opciones)).fuente, 'alicia');
});

test('LA Referencia no tiene pregrado: se le piden los demás tipos, o se explica', async () => {
  const e = entorno();
  e.aliciaCaida = true;

  await buscarEnPeruanas({ consulta: '"x"', pagina: 1, tipos: ['pregrado', 'maestria'] }, e.opciones);
  assert.deepEqual(e.llamadasRespaldo[0].tipos, ['maestria']);

  await assert.rejects(
    buscarEnPeruanas({ consulta: '"y"', pagina: 1, tipos: ['pregrado'] }, e.opciones),
    (fallo) => fallo.statusCode === 503 && /pregrado solo están ahí/.test(fallo.message),
  );
});

test('si el respaldo tampoco contesta, «ALICIA no responde» es un 503 que sale como error', async () => {
  const e = entorno();
  e.aliciaCaida = true;
  e.opciones.enRespaldo = async () => {
    throw new Error('LA Referencia respondió 502: sin JSON');
  };

  let fallo;
  try {
    await buscarEnPeruanas({ consulta: '"nada"', pagina: 1, tipos: [] }, e.opciones);
  } catch (x) {
    fallo = x;
  }
  assert.equal(fallo?.statusCode, 503);

  registro.length = 0;
  const res = {
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
  errorHandler(fallo, { method: 'POST', originalUrl: '/api/v1/mi-scopus/alicia' }, res, () => {});

  assert.equal(res.codigo, 503);
  assert.match(res.cuerpo.error.message, /ALICIA no responde/);
  assert.deepEqual(registro.map((l) => l.nivel), ['error']);
});

test('«Añadir» usa las fichas ya enseñadas y no repite la que entró por el otro catálogo', async () => {
  const e = entorno();
  e.aliciaCaida = true;
  await buscarEnPeruanas({ consulta: '"guardar"', pagina: 1, tipos: [] }, e.opciones);

  const nadie = async () => {
    throw new Error('no hacía falta pedir nada');
  };
  const pedirFichas = { alicia: nadie, lareferencia: nadie };

  const r = await alicia.importar('u1', { ids: [`lareferencia:PE_${H2}`] }, { pedirFichas });
  assert.equal(r.guardadas, 1);
  assert.deepEqual(base.guardadas, [`lareferencia:PE_${H2}`]);

  // Ya la tiene, guardada en su día desde ALICIA con otro prefijo.
  base.hashes = [H2];
  base.guardadas = [];
  const otra = await alicia.importar('u1', { ids: [`lareferencia:PE_${H2}`] }, { pedirFichas });
  assert.equal(otra.guardadas, 0);
  assert.equal(otra.repetidas, 1);
  assert.deepEqual(base.guardadas, []);
});

test('las que no se enseñaron se piden a su catálogo, cada una al suyo', async () => {
  const pedidas = {};
  const pedirFichas = {
    alicia: async (ids) => {
      pedidas.alicia = ids;
      return ids.map((id) => ficha(id));
    },
    lareferencia: async (ids) => {
      pedidas.lareferencia = ids;
      return ids.map((id) => ficha(id));
    },
  };

  const r = await alicia.importar(
    'u1',
    { ids: [`EESPPM-RI_${H1}`, `lareferencia:PE_${H2}`, 'no-vale'] },
    { pedirFichas },
  );

  assert.deepEqual(pedidas.alicia, [`EESPPM-RI_${H1}`]);
  assert.deepEqual(pedidas.lareferencia, [`lareferencia:PE_${H2}`]);
  assert.equal(r.guardadas, 2);
  assert.deepEqual(base.guardadas, [`alicia:EESPPM-RI_${H1}`, `lareferencia:PE_${H2}`]);
});
