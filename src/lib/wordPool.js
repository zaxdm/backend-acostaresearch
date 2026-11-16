'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_WORKERS = 2;
const TIMEOUT_MS = 120_000;

function cantidadWorkers(valor) {
  const numero = Number(valor);
  if (valor == null || valor === '' || !Number.isFinite(numero)) return MAX_WORKERS;
  return Math.max(1, Math.min(MAX_WORKERS, Math.floor(numero)));
}

function errorPool(message, code, causa) {
  const error = new Error(message, causa ? { cause: causa } : undefined);
  error.code = code;
  return error;
}

function recuperarBuffer(resultado) {
  const convertir = (valor) => Buffer.from(valor.buffer, valor.byteOffset, valor.byteLength);
  if (resultado instanceof Uint8Array) return convertir(resultado);
  if (resultado && resultado.buffer instanceof Uint8Array) {
    return { ...resultado, buffer: convertir(resultado.buffer) };
  }
  if (resultado instanceof ArrayBuffer) return Buffer.from(resultado);
  if (resultado && resultado.buffer instanceof ArrayBuffer) {
    return { ...resultado, buffer: Buffer.from(resultado.buffer) };
  }
  return resultado;
}

/**
 * Pool perezoso y reutilizable. El límite cuenta también los hilos que se están
 * terminando: un reemplazo se crea una vez que el anterior ha salido.
 * El plazo incluye la espera en cola y la primera carga del worker.
 */
function crearPoolWord({ archivoWorker, workers = process.env.WORD_WORKERS, timeoutMs = TIMEOUT_MS } = {}) {
  if (!archivoWorker) throw new TypeError('Falta archivoWorker para el pool de Word');
  const limite = cantidadWorkers(workers);
  const plazo = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
  const hilos = new Set();
  const cola = [];
  let secuencia = 0;
  let cerrado = false;
  let cierre;

  function completar(trabajo, error, resultado) {
    if (trabajo.terminado) return;
    trabajo.terminado = true;
    clearTimeout(trabajo.reloj);
    if (error) trabajo.rechazar(error);
    else trabajo.resolver(resultado);
  }

  function retirar(hilo, error) {
    if (hilo.retirando) return hilo.salida;
    hilo.retirando = true;
    if (hilo.trabajo) {
      completar(hilo.trabajo, error);
      hilo.trabajo = null;
    }
    // No liberar la plaza hasta que terminate() confirme la salida.
    hilo.salida = hilo.worker.terminate().catch(() => {}).finally(() => {
      hilos.delete(hilo);
      repartir();
    });
    return hilo.salida;
  }

  function crearHilo() {
    const worker = new Worker(archivoWorker);
    const hilo = { worker, trabajo: null, retirando: false, salida: null };
    hilos.add(hilo);
    worker.on('message', (mensaje) => {
      const trabajo = hilo.trabajo;
      if (hilo.retirando || !trabajo || mensaje?.id !== trabajo.id) return;
      hilo.trabajo = null;
      if (mensaje.error) {
        const error = errorPool(mensaje.error.message || 'No se pudo armar el Word', mensaje.error.code || 'WORD_WORKER_ERROR');
        error.name = mensaje.error.name || 'Error';
        if (mensaje.error.stack) error.stack = mensaje.error.stack;
        completar(trabajo, error);
      } else {
        completar(trabajo, null, recuperarBuffer(mensaje.resultado));
      }
      worker.unref();
      repartir();
    });
    worker.on('error', (causa) => {
      retirar(hilo, errorPool(`Falló el worker de Word: ${causa.message}`, 'WORD_WORKER_ERROR', causa));
    });
    worker.on('exit', (codigo) => {
      hilos.delete(hilo);
      if (!hilo.retirando && hilo.trabajo) {
        completar(hilo.trabajo, errorPool(`El worker de Word terminó inesperadamente (código ${codigo})`, 'WORD_WORKER_EXIT'));
        hilo.trabajo = null;
      }
      hilo.retirando = true;
      repartir();
    });
    worker.unref();
    return hilo;
  }

  function repartir() {
    if (cerrado) return;
    while (cola.length) {
      let hilo = [...hilos].find((candidato) => !candidato.retirando && !candidato.trabajo);
      if (!hilo && hilos.size < limite) {
        try {
          hilo = crearHilo();
        } catch (causa) {
          completar(cola.shift(), errorPool(`No se pudo iniciar el worker de Word: ${causa.message}`, 'WORD_WORKER_ERROR', causa));
          continue;
        }
      }
      if (!hilo) return;
      const trabajo = cola.shift();
      hilo.trabajo = trabajo;
      hilo.worker.ref();
      try {
        hilo.worker.postMessage({ id: trabajo.id, tipo: trabajo.tipo, datos: trabajo.datos });
      } catch (causa) {
        hilo.trabajo = null;
        hilo.worker.unref();
        completar(trabajo, errorPool(`Los datos del Word no son serializables: ${causa.message}`, 'WORD_DATA_CLONE_ERROR', causa));
      }
    }
  }

  function ejecutar(tipo, datos) {
    if (cerrado) return Promise.reject(errorPool('El pool de Word está cerrado', 'WORD_POOL_CLOSED'));
    return new Promise((resolver, rechazar) => {
      const trabajo = { id: ++secuencia, tipo, datos, resolver, rechazar, terminado: false, reloj: null };
      trabajo.reloj = setTimeout(() => {
        const error = errorPool(`La generación del Word superó el tiempo límite de ${plazo} ms (incluida la cola)`, 'WORD_TIMEOUT');
        const indice = cola.indexOf(trabajo);
        if (indice >= 0) {
          cola.splice(indice, 1);
          completar(trabajo, error);
          repartir();
          return;
        }
        const hilo = [...hilos].find((candidato) => candidato.trabajo === trabajo);
        if (hilo) retirar(hilo, error);
      }, plazo);
      cola.push(trabajo);
      repartir();
    });
  }

  function cerrar() {
    if (cierre) return cierre;
    cerrado = true;
    const error = errorPool('El pool de Word se cerró antes de terminar el trabajo', 'WORD_POOL_CLOSED');
    for (const trabajo of cola.splice(0)) completar(trabajo, error);
    cierre = Promise.all([...hilos].map((hilo) => retirar(hilo, error))).then(() => undefined);
    return cierre;
  }

  return { ejecutar, cerrar };
}

// Importar el módulo no inicia hilos ni abre conexiones a la base de datos.
const pool = crearPoolWord({ archivoWorker: path.join(__dirname, '../modules/projects/word.worker.js') });

module.exports = { crearPoolWord, ejecutar: pool.ejecutar, cerrar: pool.cerrar };
