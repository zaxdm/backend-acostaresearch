'use strict';

const logger = require('../../config/logger');
const { leerImagen } = require('../projects/project.reporte-ocr');

/**
 * Revisión automática de la captura de un pago manual.
 *
 * Para qué: llegaban fotos que no eran un comprobante (el 7-oct, la foto del
 * tablero de un auto) y nada lo frenaba. Se lee la imagen con el mismo OCR del
 * reporte de Turnitin y se buscan las tres huellas de una constancia: palabras
 * de Yape o del banco, el importe y el número de operación.
 *
 * NO DECIDE NADA. El veredicto es un aviso: al comprador, antes de enviar, para
 * que cambie la imagen si se equivocó; y al administrador, en la bandeja, para
 * que mire con más cuidado. Las capturas varían y el OCR se equivoca, así que
 * bloquear por esto dejaría fuera pagos buenos. Y al revés: una captura que
 * «parece buena» se falsifica igual de fácil; lo que cuenta sigue siendo el
 * número de operación cotejado con el extracto.
 *
 * Veredictos:
 *   OK         palabras de un comprobante y, además, el importe o la operación.
 *   DUDOSO     solo una de las huellas.
 *   NO_PARECE  ninguna: una foto, un meme, una captura de otra cosa.
 *   SIN_LEER   el OCR falló o tardó demasiado. No se avisa de nada.
 */

/** Lo que espera la web antes de rendirse: el OCR comparte cola con los reportes. */
const ESPERA_MS = 20_000;

const PALABRAS = {
  YAPE: /yape|plin|operacion|constancia|transferencia|pago exitoso|enviaste|destino|bcp|interbank|bbva|scotiabank|banco de la nacion/,
  WESTERN_UNION: /western|union|mtcn|money transfer|remitente|beneficiario|envio/,
};

/** Minúsculas y sin tildes: el OCR no siempre acierta con ellas. */
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** El número que va detrás de «operación» (o del MTCN), sin espacios. */
function operacionEn(texto, metodo) {
  const patron =
    metodo === 'WESTERN_UNION'
      ? /mtcn[^\d]{0,20}(\d[\d -]{8,14}\d)/
      : /operacion[^\d]{0,30}(\d[\d ]{4,14}\d)/;
  const hallado = texto.match(patron);
  if (!hallado) return null;
  const numero = hallado[1].replace(/[\s-]/g, '');
  if (metodo === 'WESTERN_UNION') return numero.length === 10 ? numero : null;
  return numero.length >= 6 && numero.length <= 12 ? numero : null;
}

/**
 * Si el importe aparece en la imagen: «59.90» o «59,90»; y si es redondo,
 * también «69» a secas, que es como lo enseña Yape.
 */
function montoEn(texto, amountCents) {
  if (!amountCents || amountCents <= 0) return false;
  const enteros = Math.floor(amountCents / 100);
  const centimos = String(amountCents % 100).padStart(2, '0');
  const separado = new RegExp(`(^|[^\\d])${enteros}[.,]${centimos}(?!\\d)`);
  if (separado.test(texto)) return true;
  return amountCents % 100 === 0 && new RegExp(`(^|[^\\d.,])${enteros}(?![\\d.,]*\\d)`).test(texto);
}

/** El veredicto a partir del texto ya leído. Separado del OCR para probarlo. */
function analizarTexto(texto, { amountCents, metodo = 'YAPE', operationCode } = {}) {
  const limpio = normalizar(texto);
  const palabras = (PALABRAS[metodo] ?? PALABRAS.YAPE).test(limpio);
  const operacionLeida = operacionEn(limpio, metodo);
  const montoVisto = montoEn(limpio, amountCents);

  const declarado = (operationCode || '').replace(/[\s-]/g, '');
  const operacionCoincide = declarado ? limpio.replace(/\D/g, '').includes(declarado) : null;

  const huellas = [palabras, montoVisto, Boolean(operacionLeida) || operacionCoincide === true].filter(
    Boolean,
  ).length;
  let veredicto = 'NO_PARECE';
  if (palabras && huellas >= 2) veredicto = 'OK';
  else if (huellas >= 1) veredicto = 'DUDOSO';

  return { veredicto, operacionLeida, montoVisto, operacionCoincide };
}

/**
 * Lee la captura y la analiza. Nunca lanza: si algo falla devuelve SIN_LEER,
 * porque un fallo del OCR no puede tumbar un pago.
 */
async function revisarCaptura(buffer, opciones = {}) {
  let vigente = true;
  let reloj;
  try {
    const texto = await Promise.race([
      leerImagen(buffer, { vigente: () => vigente }),
      new Promise((resolve) => {
        reloj = setTimeout(() => resolve(null), opciones.esperaMs ?? ESPERA_MS);
      }),
    ]);
    if (texto === null) return { veredicto: 'SIN_LEER' };
    return analizarTexto(texto, opciones);
  } catch (error) {
    logger.warn({ err: error }, 'No se pudo leer la captura de un pago manual');
    return { veredicto: 'SIN_LEER' };
  } finally {
    vigente = false;
    clearTimeout(reloj);
  }
}

module.exports = { analizarTexto, revisarCaptura };
