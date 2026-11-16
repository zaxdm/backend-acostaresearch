'use strict';

const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { setTimeout: esperar } = require('node:timers/promises');
const { armarDirecto } = require('../../src/modules/projects/word.generacion');
const { crearPoolWord } = require('../../src/lib/wordPool');
const { proyecto, proyectoGrande } = require('./word.datos');

async function medir(armar) {
  let anterior = performance.now();
  let retrasoMaximoMs = 0;
  let muestras = 0;
  const reloj = setInterval(() => {
    const ahora = performance.now();
    retrasoMaximoMs = Math.max(retrasoMaximoMs, ahora - anterior - 10);
    anterior = ahora;
    muestras += 1;
  }, 10);
  try {
    await esperar(30);
    const inicio = performance.now();
    const muestrasAlComenzar = muestras;
    const resultado = await armar();
    const duracionMs = performance.now() - inicio;
    const muestrasDurante = muestras - muestrasAlComenzar;
    await esperar(30);
    return { retrasoMaximoMs, muestras, muestrasDurante, duracionMs, bytes: resultado.buffer.length, fuentes: resultado.usadas };
  } finally {
    clearInterval(reloj);
  }
}

(async () => {
  const datos = proyectoGrande();
  const antes = await medir(() => armarDirecto('proyecto', datos));
  const pool = crearPoolWord({ archivoWorker: path.resolve(__dirname, '../../src/modules/projects/word.worker.js'), workers: 2 });
  try {
    // Arranque fuera de la medida: se mide la generación en workers reutilizados.
    await pool.ejecutar('proyecto', proyecto());
    const despues = await medir(() => pool.ejecutar('proyecto', datos));
    process.stdout.write(JSON.stringify({ citas: 400, fuentes: datos.fuentes.length, antes, despues }));
  } finally {
    await pool.cerrar();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
