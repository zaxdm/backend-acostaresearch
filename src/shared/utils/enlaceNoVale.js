'use strict';

/**
 * Qué se le dice a quien abre un enlace del conector que no vale.
 *
 * Antes cualquier fallo decía «ya no vale: dura media hora», y eso escondía dos
 * cosas distintas. Con ChatGPT pasaba que el asistente repetía un enlace de
 * horas antes, o lo reescribía a mano y le cambiaba un carácter; el estudiante
 * leía lo mismo en los dos casos y nadie sabía cuál había sido.
 *
 * `jsonwebtoken` solo lanza `TokenExpiredError` DESPUÉS de comprobar la firma,
 * así que «venció» solo lo lee quien tiene en la mano un enlace auténtico: no
 * da pistas a quien prueba tokens inventados, que ven «llegó incompleto».
 *
 * Los textos no nombran a ningún asistente: el conector se usa desde Claude,
 * ChatGPT o Grok.
 */

/** Verdadero si el enlace era auténtico y solo pasó su media hora. */
const vencido = (error) => error?.name === 'TokenExpiredError';

/**
 * El mensaje para el estudiante. `para` completa la frase: «Este enlace para
 * subir tu formato venció…». Sin `para`, «Este enlace venció…».
 */
function mensajeEnlaceNoVale(error, opciones = {}) {
  return textoEnlaceNoVale(vencido(error), opciones);
}

/**
 * El mismo texto cuando no hay ningún error de `jsonwebtoken` que mirar, sino
 * una fila de la base: el enlace corto que existió y se pasó de hora, o el que
 * no está. Ver `enlaceCorto.service`.
 */
function textoEnlaceNoVale(haVencido, { para = '', minutos = 30 } = {}) {
  const enlace = para ? `Este enlace para ${para}` : 'Este enlace';
  if (haVencido) {
    return (
      `${enlace} venció: dura ${minutos} minutos. Vuelve a tu conversación y pide uno nuevo; ` +
      'no reutilices uno anterior.'
    );
  }
  return (
    `${enlace} llegó incompleto o alterado. Vuelve a tu conversación y pide uno nuevo, y ábrelo ` +
    'pulsándolo, sin copiar la dirección a mano.'
  );
}

module.exports = { mensajeEnlaceNoVale, textoEnlaceNoVale, vencido };
