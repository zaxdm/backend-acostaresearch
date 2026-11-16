'use strict';

/** Entropía reproducible únicamente para comparar XML, nunca para producción. */
function instalar() {
  const crypto = require('node:crypto');
  const originales = {
    Date: global.Date,
    random: Math.random,
    randomBytes: crypto.randomBytes,
    randomInt: crypto.randomInt,
  };
  let estado;
  const reiniciar = () => { estado = 123456789; };
  const aleatorio = () => {
    estado = (Math.imul(estado, 1664525) + 1013904223) >>> 0;
    return estado / 0x100000000;
  };
  reiniciar();
  global.Date = class extends originales.Date {
    constructor(...argumentos) {
      super(...(argumentos.length ? argumentos : ['2026-11-16T12:00:00.000Z']));
    }
    static now() { return 1794830400000; }
  };
  Math.random = aleatorio;
  crypto.randomBytes = (cantidad) => Buffer.from(Array.from({ length: cantidad }, () => Math.floor(aleatorio() * 256)));
  crypto.randomInt = (minimo, maximo) => {
    if (maximo === undefined) [minimo, maximo] = [0, minimo];
    return minimo + Math.floor(aleatorio() * (maximo - minimo));
  };
  return {
    reiniciar,
    restaurar() {
      global.Date = originales.Date;
      Math.random = originales.random;
      crypto.randomBytes = originales.randomBytes;
      crypto.randomInt = originales.randomInt;
    },
  };
}

module.exports = { instalar };
