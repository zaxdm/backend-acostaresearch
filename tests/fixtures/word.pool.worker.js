'use strict';

const { parentPort, threadId } = require('node:worker_threads');

let trabajos = 0;
parentPort.on('message', async ({ id, tipo, datos }) => {
  trabajos += 1;
  if (tipo === 'salir') process.exit(17);
  if (tipo === 'romper') throw new Error('Fallo no capturado del worker de prueba');
  if (tipo === 'esperar') await new Promise((resolver) => setTimeout(resolver, datos.ms));
  if (tipo === 'error') {
    parentPort.postMessage({ id, error: { name: 'TypeError', message: 'Documento inválido', code: 'WORD_INVALIDO' } });
    return;
  }
  const buffer = Uint8Array.from([80, 75, datos?.valor ?? 0]);
  parentPort.postMessage({ id, resultado: { threadId, trabajos, valor: datos?.valor, buffer } }, [buffer.buffer]);
});
