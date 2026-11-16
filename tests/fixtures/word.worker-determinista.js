'use strict';

const { parentPort } = require('node:worker_threads');
const { instalar } = require('./word.entropia');
const entropia = instalar();

// El mismo worker se reutiliza: cada trabajo debe empezar con la misma semilla
// que la ejecución directa, sin reemplazar ni normalizar IDs en el XML.
parentPort.on('message', () => entropia.reiniciar());

require('../../src/modules/projects/word.worker');

// Los estilos/idiomas y la plantilla ya deben venir cargados desde el main.
const fs = require('node:fs');
const leer = fs.readFileSync;
fs.readFileSync = function (archivo, ...argumentos) {
  if (/\.(?:csl|xml|docx)$/i.test(String(archivo))) {
    throw new Error(`El worker intentó leer un recurso del documento: ${archivo}`);
  }
  return leer.call(this, archivo, ...argumentos);
};
