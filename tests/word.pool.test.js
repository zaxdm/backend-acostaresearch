'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { crearPoolWord } = require('../src/lib/wordPool');

const archivoWorker = path.join(__dirname, 'fixtures/word.pool.worker.js');

function poolDePrueba(t, opciones = {}) {
  const pool = crearPoolWord({ archivoWorker, timeoutMs: 5_000, ...opciones });
  t.after(() => pool.cerrar());
  return pool;
}

test('Word: la cola es FIFO y reutiliza el mismo worker', async (t) => {
  const pool = poolDePrueba(t, { workers: 1 });
  const orden = [];
  const resultados = await Promise.all([60, 5, 1].map((ms, valor) =>
    pool.ejecutar('esperar', { ms, valor }).then((resultado) => {
      orden.push(valor);
      return resultado;
    }),
  ));
  assert.deepEqual(orden, [0, 1, 2]);
  assert.equal(new Set(resultados.map((r) => r.threadId)).size, 1);
  assert.deepEqual(resultados.map((r) => r.trabajos), [1, 2, 3]);
  assert.ok(Buffer.isBuffer(resultados[0].buffer));
  assert.deepEqual(resultados[2].buffer, Buffer.from([80, 75, 2]));
});

test('Word: WORD_WORKERS configura el límite y nunca permite más de dos workers', async (t) => {
  const anterior = process.env.WORD_WORKERS;
  t.after(() => {
    if (anterior === undefined) delete process.env.WORD_WORKERS;
    else process.env.WORD_WORKERS = anterior;
  });
  for (const [valor, esperado] of [[undefined, 2], ['1', 1], ['9', 2], ['0', 1], ['inválido', 2]]) {
    if (valor === undefined) delete process.env.WORD_WORKERS;
    else process.env.WORD_WORKERS = valor;
    const pool = poolDePrueba(t);
    const resultados = await Promise.all(Array.from({ length: 6 }, (_, numero) =>
      pool.ejecutar('esperar', { ms: 15, valor: numero }),
    ));
    assert.equal(new Set(resultados.map((r) => r.threadId)).size, esperado, `WORD_WORKERS=${valor}`);
    await pool.cerrar();
  }
});

test('Word: un error del documento conserva el worker y los datos no clonables no bloquean la cola', async (t) => {
  const pool = poolDePrueba(t, { workers: 1 });
  const primero = await pool.ejecutar('datos', { valor: 3 });
  await assert.rejects(pool.ejecutar('error', {}), { name: 'TypeError', message: 'Documento inválido', code: 'WORD_INVALIDO' });
  await assert.rejects(pool.ejecutar('datos', { funcion() {} }), { code: 'WORD_DATA_CLONE_ERROR' });
  const siguiente = await pool.ejecutar('datos', { valor: 4 });
  assert.equal(siguiente.threadId, primero.threadId);
  assert.equal(siguiente.trabajos, 3);
});

test('Word: el timeout rechaza el trabajo, termina el worker y permite recrearlo', async (t) => {
  const pool = poolDePrueba(t, { workers: 1, timeoutMs: 3_000 });
  const primero = await pool.ejecutar('datos', {});
  await assert.rejects(pool.ejecutar('esperar', { ms: 30_000 }), { code: 'WORD_TIMEOUT' });
  const siguiente = await pool.ejecutar('datos', { valor: 8 });
  assert.notEqual(siguiente.threadId, primero.threadId);
  assert.equal(siguiente.trabajos, 1);
});

test('Word: el tiempo límite también cubre la espera en cola', async (t) => {
  const pool = poolDePrueba(t, { workers: 1, timeoutMs: 3_000 });
  const resultados = await Promise.allSettled([
    pool.ejecutar('esperar', { ms: 30_000 }),
    pool.ejecutar('datos', {}),
  ]);
  assert.deepEqual(resultados.map((r) => r.status), ['rejected', 'rejected']);
  assert.deepEqual(resultados.map((r) => r.reason.code), ['WORD_TIMEOUT', 'WORD_TIMEOUT']);
  assert.match(resultados[1].reason.message, /incluida la cola/);
  assert.ok(Buffer.isBuffer((await pool.ejecutar('datos', {})).buffer));
});

for (const [tipo, codigo] of [['salir', 'WORD_WORKER_EXIT'], ['romper', 'WORD_WORKER_ERROR']]) {
  test(`Word: recupera un worker tras ${tipo} y atiende lo que esperaba en cola`, async (t) => {
    const pool = poolDePrueba(t, { workers: 1 });
    const primero = await pool.ejecutar('datos', {});
    const fallo = assert.rejects(pool.ejecutar(tipo, {}), { code: codigo });
    const siguiente = pool.ejecutar('datos', { valor: 9 });
    await fallo;
    const resultado = await siguiente;
    assert.notEqual(resultado.threadId, primero.threadId);
    assert.equal(resultado.trabajos, 1);
  });
}

test('Word: un archivo de worker roto rechaza sin entrar en un ciclo de reinicios', async (t) => {
  const pool = poolDePrueba(t, { archivoWorker: path.join(__dirname, 'fixtures/no-existe-word.worker.js'), workers: 1 });
  await assert.rejects(pool.ejecutar('datos', {}), { code: 'WORD_WORKER_ERROR' });
  await pool.cerrar();
});

test('Word: cerrar rechaza pendientes y nuevas tareas, y se puede llamar varias veces', async (t) => {
  const pool = poolDePrueba(t, { workers: 1 });
  const trabajos = [pool.ejecutar('esperar', { ms: 10_000 }), pool.ejecutar('datos', {})];
  const rechazados = trabajos.map((trabajo) => assert.rejects(trabajo, { code: 'WORD_POOL_CLOSED' }));
  const cierre = pool.cerrar();
  assert.equal(pool.cerrar(), cierre);
  await Promise.all([...rechazados, cierre]);
  await assert.rejects(pool.ejecutar('datos', {}), { code: 'WORD_POOL_CLOSED' });
});

test('Word: los workers ociosos permiten terminar el proceso', async () => {
  const modulo = require.resolve('../src/lib/wordPool');
  const programa = `const { crearPoolWord } = require(${JSON.stringify(modulo)}); crearPoolWord({ archivoWorker: ${JSON.stringify(archivoWorker)}, workers: 1 }).ejecutar('datos', {}).then(() => console.log('terminado'));`;
  const hijo = spawn(process.execPath, ['-e', programa], { windowsHide: true });
  let salida = '';
  let errores = '';
  hijo.stdout.on('data', (datos) => { salida += datos; });
  hijo.stderr.on('data', (datos) => { errores += datos; });
  const codigo = await new Promise((resolver, rechazar) => {
    const reloj = setTimeout(() => {
      hijo.kill();
      rechazar(new Error('El worker ocioso mantuvo vivo el proceso'));
    }, 5_000);
    hijo.once('error', (error) => { clearTimeout(reloj); rechazar(error); });
    hijo.once('exit', (valor) => { clearTimeout(reloj); resolver(valor); });
  });
  assert.equal(codigo, 0, errores);
  assert.match(salida, /terminado/);
});
