'use strict';

/**
 * ALICIA lenta o caída. El 9 y el 10-oct-2026 pasó de tardar veinte segundos
 * por búsqueda a no contestar en toda la mañana. Lo que tiene que ser cierto:
 *
 *   · La misma búsqueda no se le vuelve a pedir a ALICIA durante media hora.
 *   · Si ALICIA no contesta, se enseña lo que ya había contestado; si no hay
 *     nada, se busca en LA Referencia y la respuesta dice de dónde viene.
 *   · Tras un fallo no se hace esperar a nadie más: se va al respaldo con
 *     ALICIA por detrás. Solo tres fallos seguidos son una caída: entonces se
 *     la sondea cada tres minutos y nada más. Cuando contesta, se vuelve a ella.
 *   · Cada fallo de ALICIA se anota como ERROR aunque el tesista vea
 *     resultados: el aviso al administrador es a propósito.
 *   · LA Referencia no tiene pregrado: pedir solo pregrado con ALICIA caída es
 *     un «no responde» que lo explica, no una lista vacía.
 *   · LENTA no es caída (10-oct por la tarde: contestaba en 16 a 31 s). Se
 *     enseña el respaldo inmediatamente y la pregunta sigue
 *     viva por detrás. Nadie la espera, salvo quien
 *     filtra solo pregrado. Lo que llega se guarda y se le da a quien lo
 *     esperaba; que tarde no es un error.
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

test('sin caché consulta el respaldo inmediatamente y ALICIA actualiza después', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  const peticion = { consulta: 'inmediata', tipos: [] };
  const r = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(r.fuente, 'lareferencia');
  assert.equal(r.aliciaEnCamino, true);
  const esperando = alicia.loQueTraigaAlicia(peticion, e.opciones);
  lenta.contesta(321);
  assert.equal((await esperando).total, 321);
});

test('la caché persistente sobrevive a reiniciar la memoria y restaura las fichas', async () => {
  const e = entorno();
  const disco = new Map();
  e.opciones.cache = {
    leer: async (clave) => disco.get(clave),
    guardar: async (clave, respuesta, en) => disco.set(clave, { respuesta, en }),
  };
  const peticion = { consulta: 'persistente', tipos: [] };
  await buscarEnPeruanas(peticion, e.opciones);
  await tick();
  alicia.reiniciar();
  const r = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(r.total, 101);
  assert.equal(r.fuente, 'alicia');
  assert.equal(e.llamadasAlicia, 1);
  assert.equal((await alicia.loQueTraigaAlicia(peticion, e.opciones)).total, 101);
});

test('si el respaldo falla se conserva la respuesta que llegue de ALICIA', async () => {
  const e = entorno();
  e.opciones.enRespaldo = async () => { throw new Error('sin respaldo'); };
  const r = await buscarEnPeruanas({ consulta: 'rescate', tipos: [] }, e.opciones);
  assert.equal(r.fuente, 'alicia');
  assert.equal(r.total, 101);
});

test('el límite de consultas también se aplica antes de detectar lentitud', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  const peticiones = Array.from({ length: 6 }, (_, i) => ({ consulta: `limite-${i}`, tipos: [] }));
  const resultados = await Promise.all(peticiones.map((p) => buscarEnPeruanas(p, e.opciones)));
  assert.equal(e.llamadasAlicia, 4);
  assert.equal(resultados.filter((r) => r.aliciaEnCamino).length, 4);
  for (let i = 0; i < 4; i++) lenta.contesta();
  await tick();
});

test('solo pregrado sí pregunta aunque haya cuatro búsquedas con respaldo en camino', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  for (let i = 0; i < 4; i++) {
    await buscarEnPeruanas({ consulta: `ocupada-${i}`, tipos: [] }, e.opciones);
  }
  const esperando = buscarEnPeruanas({ consulta: 'pregrado-quinta', tipos: ['pregrado'] }, e.opciones);
  assert.equal(e.llamadasAlicia, 5);
  for (let i = 0; i < 4; i++) lenta.contesta();
  lenta.contesta(77);
  const r = await esperando;
  assert.equal(r.fuente, 'alicia');
  assert.equal(r.total, 77);
  assert.equal(e.llamadasRespaldo.length, 4);
});

test('la misma búsqueda no se le repite a ALICIA durante media hora', async () => {
  const e = entorno();
  const peticion = { consulta: '"memoria"', pagina: 1, tipos: ['maestria', 'doctorado'] };

  const primera = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(primera.fuente, 'lareferencia');
  await alicia.loQueTraigaAlicia(peticion, e.opciones);

  e.reloj += 29 * 60 * 1000;
  // Los mismos tipos en otro orden son la misma búsqueda.
  const otraVez = await buscarEnPeruanas({ ...peticion, tipos: ['doctorado', 'maestria'] }, e.opciones);
  assert.equal(otraVez.total, 101);
  assert.equal(e.llamadasAlicia, 1);

  // Otra página sí es otra pregunta, y pasada la media hora se vuelve a pedir.
  await buscarEnPeruanas({ ...peticion, pagina: 2 }, e.opciones);
  assert.equal((await alicia.loQueTraigaAlicia({ ...peticion, pagina: 2 }, e.opciones)).total, 102);
  e.reloj += 2 * 60 * 1000;
  assert.equal((await buscarEnPeruanas(peticion, e.opciones)).total, 101);
  await tick();
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
  assert.equal(e.llamadasRespaldo.length, 1);
});

test('un fallo suelto no es una caída: se le sigue preguntando por detrás', async () => {
  const e = entorno();
  e.aliciaCaida = true;
  await buscarEnPeruanas({ consulta: '"a"', pagina: 1, tipos: [] }, e.opciones);

  // Falló una vez y ahora contesta: la siguiente no la espera, pero le pregunta.
  e.aliciaCaida = false;
  const b = await buscarEnPeruanas({ consulta: '"b"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(b.fuente, 'lareferencia');
  assert.equal(b.aliciaEnCamino, true);
  assert.equal(e.llamadasAlicia, 2);
  assert.equal((await alicia.loQueTraigaAlicia({ consulta: '"b"', pagina: 1, tipos: [] }, e.opciones)).total, 102);

  // Aunque responda a tiempo, una nueva consulta usa primero el respaldo.
  assert.equal((await buscarEnPeruanas({ consulta: '"c"', pagina: 1, tipos: [] }, e.opciones)).fuente, 'lareferencia');
});

test('tres fallos seguidos: caída; se la sondea cada tres minutos y se vuelve a ella', async () => {
  const e = entorno();
  e.aliciaCaida = true;

  for (const letra of ['x', 'y', 'a']) {
    await buscarEnPeruanas({ consulta: `"${letra}"`, pagina: 1, tipos: [] }, e.opciones);
    await tick();
  }
  assert.equal(e.llamadasAlicia, 3);
  registro.length = 0;
  e.llamadasAlicia = 1;

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
  assert.equal(registro.filter((l) => l.nivel === 'error').length, 1, 'el sondeo fallido también avisa');

  // ALICIA vuelve: el siguiente sondeo lo descubre y la búsqueda de después ya es suya.
  e.aliciaCaida = false;
  e.reloj += 3 * 60 * 1000;
  assert.equal((await buscarEnPeruanas({ consulta: '"d"', pagina: 1, tipos: [] }, e.opciones)).fuente, 'lareferencia');
  await tick();
  assert.ok(registro.some((l) => l.msg === 'ALICIA volvió a responder'));

  const despues = await buscarEnPeruanas({ consulta: '"e"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(despues.fuente, 'lareferencia');
  // Y lo que trajo el sondeo quedó guardado para quien lo pidió.
  assert.equal((await buscarEnPeruanas({ consulta: '"d"', pagina: 1, tipos: [] }, e.opciones)).fuente, 'alicia');
});

test('LA Referencia no tiene pregrado: se le piden los demás tipos, o se explica', async () => {
  const e = entorno();
  e.aliciaCaida = true;

  await buscarEnPeruanas({ consulta: '"x"', pagina: 1, tipos: ['pregrado', 'maestria'] }, e.opciones);
  assert.deepEqual(e.llamadasRespaldo[0].tipos, ['maestria']);

  // Solo pregrado: se le pregunta a ALICIA aunque acabe de fallar, que no hay otro sitio.
  const soloPregrado = (consulta) =>
    assert.rejects(
      buscarEnPeruanas({ consulta, pagina: 1, tipos: ['pregrado'] }, e.opciones),
      (fallo) => fallo.statusCode === 503 && /pregrado no están disponibles/.test(fallo.message),
    );
  await soloPregrado('"y"');
  await soloPregrado('"z"');
  assert.equal(e.llamadasAlicia, 3);

  // Ya son tres fallos: caída, y se explica sin hacerle esperar otra vez.
  await soloPregrado('"w"');
  assert.equal(e.llamadasAlicia, 3);
});

/** Una ALICIA que contesta cuando se le dice. */
function aliciaLenta(e) {
  const pendientes = [];
  e.opciones.enAlicia = () => {
    e.llamadasAlicia += 1;
    return new Promise((listo, falla) => pendientes.push({ listo, falla }));
  };
  return {
    contesta: (total = 500) => pendientes.shift().listo({ total, fichas: [ficha(`UPAO_${H1}`)] }),
    falla: () => pendientes.shift().falla(TIMEOUT),
  };
}

test('ALICIA lenta: se enseña el respaldo inmediatamente y ella sigue por detrás', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  const peticion = { consulta: '"lenta"', pagina: 1, tipos: [] };

  const r = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(r.fuente, 'lareferencia');
  assert.equal(r.aliciaEnCamino, true);

  // La web se queda esperando; pedir lo mismo otra vez no le pregunta dos veces.
  const esperando = alicia.loQueTraigaAlicia(peticion, e.opciones);
  assert.equal((await buscarEnPeruanas(peticion, e.opciones)).aliciaEnCamino, true);
  assert.equal(e.llamadasAlicia, 1);

  e.reloj += 25_000;
  lenta.contesta(500);
  assert.equal((await esperando).total, 500);

  // Quedó guardado, y que tardara no es un error.
  const despues = await buscarEnPeruanas(peticion, e.opciones);
  assert.equal(despues.fuente, 'alicia');
  assert.equal(despues.aliciaEnCamino, false);
  assert.equal(e.llamadasAlicia, 1);
  assert.equal(registro.filter((l) => l.nivel === 'error').length, 0);
});

test('el respaldo es inmediato aunque ALICIA vuelva a responder a tiempo', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  await buscarEnPeruanas({ consulta: '"uno"', pagina: 1, tipos: [] }, e.opciones);

  // La segunda respuesta sigue pendiente; no debe esperarla.
  const dos = await buscarEnPeruanas({ consulta: '"dos"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(dos.fuente, 'lareferencia');
  assert.equal(dos.aliciaEnCamino, true);
  assert.equal(e.llamadasAlicia, 2);

  // Sin pregunta de camino no hay nada que esperar.
  assert.equal(await alicia.loQueTraigaAlicia({ consulta: '"otra"', pagina: 1, tipos: [] }, e.opciones), null);

  // La segunda vuelve enseguida: ALICIA ya no está lenta.
  lenta.contesta();
  lenta.contesta();
  await tick();
  const e2 = { ...e.opciones, enAlicia: async () => ({ total: 9, fichas: [] }) };
  assert.equal((await buscarEnPeruanas({ consulta: '"tres"', pagina: 1, tipos: [] }, e2)).fuente, 'lareferencia');
});

test('lenta y con muchas preguntas de camino: no se le echan más encima', async () => {
  const e = entorno();
  aliciaLenta(e);
  for (const letra of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await buscarEnPeruanas({ consulta: `"${letra}"`, pagina: 1, tipos: [] }, e.opciones);
  }
  assert.equal(e.llamadasAlicia, 4);
  const ultima = await buscarEnPeruanas({ consulta: '"g"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(ultima.fuente, 'lareferencia');
  assert.equal(ultima.aliciaEnCamino, false);
});

test('solo pregrado con ALICIA lenta: se la espera lo que tarde', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  await buscarEnPeruanas({ consulta: '"uno"', pagina: 1, tipos: [] }, e.opciones);

  const pregrado = buscarEnPeruanas({ consulta: '"tesis"', pagina: 1, tipos: ['pregrado'] }, e.opciones);
  await new Promise((listo) => setTimeout(listo, 40));
  lenta.contesta(1);
  lenta.contesta(77);
  const r = await pregrado;
  assert.equal(r.fuente, 'alicia');
  assert.equal(r.total, 77);
  assert.equal(e.llamadasRespaldo.length, 1);
});

test('la pregunta de por detrás falla: avisa, y quien esperaba se queda con el respaldo', async () => {
  const e = entorno();
  const lenta = aliciaLenta(e);
  const peticion = { consulta: '"cae"', pagina: 1, tipos: [] };
  await buscarEnPeruanas(peticion, e.opciones);

  const esperando = alicia.loQueTraigaAlicia(peticion, e.opciones);
  lenta.falla();
  assert.equal(await esperando, null);
  assert.deepEqual(
    registro.filter((l) => l.nivel === 'error').map((l) => l.msg),
    ['ALICIA no responde: se busca en LA Referencia'],
  );

  // Un fallo no es una caída: a la siguiente se le pregunta, por detrás.
  const otra = await buscarEnPeruanas({ consulta: '"otra"', pagina: 1, tipos: [] }, e.opciones);
  assert.equal(otra.fuente, 'lareferencia');
  assert.equal(otra.aliciaEnCamino, true);
  assert.equal(e.llamadasAlicia, 2);
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
  assert.match(res.cuerpo.error.message, /repositorios no responden/);
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
