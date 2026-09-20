'use strict';

/**
 * Enlaces cortos para los que reparte el conector.
 *
 * POR QUÉ
 * -------
 * El asistente tiene que reproducir en la conversación un JWT de unos 400
 * caracteres. El 20-sep-2026 se comprobó que ChatGPT no lo copia: lo vuelve a
 * escribir y se equivoca en uno. Ver el modelo `EnlaceCorto` para la prueba.
 *
 * EL ALFABETO
 * -----------
 * Sin `0`/`O` ni `1`/`I`/`l`, porque estos códigos acaban leyéndose en voz alta
 * o copiándose a mano desde la pantalla de un móvil. Quedan 32 símbolos; con
 * ocho, unas 10^12 combinaciones, y solo están vivas las de la última media
 * hora. Adivinar una a ciegas no es un camino.
 *
 * LAS COLISIONES
 * --------------
 * `codigo` es la clave primaria, así que una repetición la rechaza la base, no
 * este código. Se reintenta un puñado de veces y, si aun así no hay hueco, se
 * devuelve el enlace largo: que el tesista vea una dirección fea es mucho mejor
 * que no darle ninguna.
 */

const crypto = require('node:crypto');

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO = 8;
const INTENTOS = 5;

/** Un código al azar, sin sesgo: se descarta lo que no reparte el byte entero. */
function codigoNuevo() {
  let codigo = '';
  while (codigo.length < LARGO) {
    for (const byte of crypto.randomBytes(LARGO)) {
      if (byte >= 256 - (256 % ALFABETO.length)) continue;
      codigo += ALFABETO[byte % ALFABETO.length];
      if (codigo.length === LARGO) break;
    }
  }
  return codigo;
}

/**
 * Guarda `destino` detrás de un código y devuelve el enlace corto.
 *
 * `minutos` es el de la caducidad del token que lleva dentro: los dos vencen a
 * la vez, para que nunca haya un código vivo que lleve a un token muerto.
 */
async function acortar({ destino, minutos, base }) {
  const expiresAt = new Date(Date.now() + minutos * 60 * 1000);

  for (let intento = 0; intento < INTENTOS; intento += 1) {
    const codigo = codigoNuevo();
    try {
      await prisma.enlaceCorto.create({ data: { codigo, destino, expiresAt } });
      return `${String(base).replace(/\/$/, '')}/s/${codigo}`;
    } catch (error) {
      // P2002: ese código ya existía. Cualquier otra cosa no es cosa nuestra.
      if (error?.code !== 'P2002') throw error;
    }
  }

  logger.warn('No se pudo acortar un enlace: cinco códigos seguidos ya existían');
  return destino;
}

/**
 * A dónde lleva un código. Devuelve `{ destino }`, o por qué no vale:
 * `'vencido'` si existió y se le pasó la hora, `'desconocido'` si no está.
 *
 * La diferencia importa: es la que decide si el tesista lee «venció, pide otro»
 * o «llegó incompleto». Por eso las filas caducadas no se borran al vencer.
 */
async function resolver(codigo) {
  const fila = await prisma.enlaceCorto.findUnique({ where: { codigo: String(codigo ?? '') } });
  if (!fila) return { motivo: 'desconocido' };
  if (fila.expiresAt.getTime() <= Date.now()) return { motivo: 'vencido' };
  return { destino: fila.destino };
}

/**
 * Borra los que llevan un día caducados.
 *
 * No hay proceso programado que mantener: lo llama la propia resolución, de
 * tarde en tarde. Un día de sobra es de sobra para que nadie que abra un enlace
 * viejo lea «llegó incompleto» cuando lo que pasó es que venció.
 */
async function limpiar() {
  const corte = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { count } = await prisma.enlaceCorto.deleteMany({ where: { expiresAt: { lt: corte } } });
  return count;
}

module.exports = { acortar, resolver, limpiar, ALFABETO, LARGO };
