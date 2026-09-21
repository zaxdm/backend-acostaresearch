'use strict';

/**
 * Los vectores de texto guardados en la base: se calculan una vez y sirven
 * para siempre, a todos.
 *
 * POR QUÉ EN LA BASE Y NO SOLO EN MEMORIA
 * ---------------------------------------
 * El vector de un artículo no cambia nunca, pero la memoria del proceso se
 * vacía en cada reinicio, y cada despliegue es un reinicio: el 20-sep hubo
 * quince. Cada vez se volvía a pedir a Gemini lo que ya se tenía, contra el
 * tope de cien textos por minuto del plan gratuito, que es para toda la
 * plataforma. Guardados aquí, el mismo artículo no se pide dos veces aunque lo
 * busquen tesistas distintos en días distintos.
 *
 * NUNCA ROMPE UNA BÚSQUEDA
 * ------------------------
 * Esto es un atajo, no una dependencia: si la base no responde, se lee como si
 * no hubiera nada guardado y no se guarda nada, y la búsqueda sigue pidiéndolo
 * todo a Gemini como antes. Por eso ninguna función de aquí lanza.
 *
 * CÓMO SE GUARDA UN VECTOR
 * ------------------------
 * Como 32 bits por número: 768 números son 3 KB. Gemini los da en 64 bits,
 * pero para comparar parecidos la diferencia está en el séptimo decimal y no
 * cambia ningún orden.
 */

const crypto = require('node:crypto');

const prisma = require('./prisma');
const logger = require('../config/logger');

/** La clave de un texto: el hash de modelo, tarea y texto, en hexadecimal. */
const claveDe = (modelo, tarea, texto) =>
  crypto.createHash('sha256').update(`${modelo}\u0000${tarea}\u0000${texto}`).digest('hex');

const aBytes = (vector) => Buffer.from(new Float32Array(vector).buffer);

/**
 * De bytes a números. Se copia antes de leer: el Buffer que devuelve la base
 * puede empezar a mitad de un bloque de memoria, y un Float32Array exige que
 * empiece en múltiplo de cuatro.
 */
const deBytes = (bytes) => Array.from(new Float32Array(new Uint8Array(bytes).buffer));

/**
 * Los vectores guardados de estas claves, en un Map clave → vector.
 * Vacío si la base no responde.
 */
async function leer(claves, { db = prisma } = {}) {
  if (claves.length === 0) return new Map();
  try {
    const filas = await db.vectorDeTexto.findMany({
      where: { clave: { in: claves } },
      select: { clave: true, vector: true },
    });
    return new Map(filas.map((f) => [f.clave, deBytes(f.vector)]));
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'Vectores guardados: no se pudieron leer; se piden a Gemini');
    return new Map();
  }
}

/** Guarda estos vectores. Los que ya estaban se dejan como estaban. */
async function guardar(filas, { db = prisma } = {}) {
  if (filas.length === 0) return;
  try {
    await db.vectorDeTexto.createMany({
      data: filas.map(({ clave, modelo, vector }) => ({ clave, modelo, vector: aBytes(vector) })),
      skipDuplicates: true,
    });
  } catch (fallo) {
    logger.warn({ err: fallo.message }, 'Vectores guardados: no se pudieron guardar');
  }
}

module.exports = { claveDe, leer, guardar, aBytes, deBytes };
