'use strict';

/**
 * Descartar sin preguntar a la base lo que seguro no es una licencia.
 *
 * Cada llamada al conector con una licencia inventada era una consulta, y la
 * base tiene cinco conexiones: una ráfaga de URLs aleatorias las ocupaba todas
 * y la web entera daba error. Dos filtros, antes de consultar:
 *
 *   · El formato. Toda licencia y todo conector de prueba se generan con 32
 *     bytes en base64url, así que miden 43 caracteres de ese alfabeto, siempre.
 *   · Las que ya se sabe que no existen. Un conector instalado con la URL de
 *     antes de rotarla sigue llamando con ella en cada mensaje; se recuerda un
 *     rato que no existe. Solo las inexistentes: una revocada o caducada puede
 *     volver a valer, y esas se preguntan siempre.
 */

const FORMATO = /^[A-Za-z0-9_-]{43}$/;
const RECUERDO_MS = 10 * 60 * 1000;
const MAXIMO_RECORDADAS = 5000;

function crearFiltro({ ahora = () => Date.now() } = {}) {
  const desconocidas = new Map();

  return {
    pareceLicencia(token) {
      return typeof token === 'string' && FORMATO.test(token);
    },

    esDesconocida(token) {
      const hasta = desconocidas.get(token);
      if (hasta === undefined) return false;
      if (hasta > ahora()) return true;
      desconocidas.delete(token);
      return false;
    },

    recordarDesconocida(token) {
      // Con el tope lleno se olvida la más antigua: un Map recorre en orden de alta.
      if (!desconocidas.has(token) && desconocidas.size >= MAXIMO_RECORDADAS) {
        desconocidas.delete(desconocidas.keys().next().value);
      }
      desconocidas.set(token, ahora() + RECUERDO_MS);
    },
  };
}

module.exports = { crearFiltro, filtro: crearFiltro(), RECUERDO_MS, MAXIMO_RECORDADAS };
