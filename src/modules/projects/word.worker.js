'use strict';

const { parentPort } = require('node:worker_threads');
const { armarDirecto } = require('./word.generacion');

parentPort.on('message', async ({ id, tipo, datos }) => {
  try {
    const resultado = await armarDirecto(tipo, datos);
    // Un ArrayBuffer propio evita copiar el ZIP al devolverlo y no transfiere
    // el slab compartido de Buffer ni bytes ajenos al documento.
    const bytes = new Uint8Array(resultado.buffer.length);
    bytes.set(resultado.buffer);
    parentPort.postMessage({ id, resultado: { ...resultado, buffer: bytes } }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: {
      name: error.constructor?.name ?? error.name,
      message: error.message, code: error.code, stack: error.stack,
    } });
  }
});
