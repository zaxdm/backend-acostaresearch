'use strict';

/**
 * Las dos puertas de R que no pasan por el conector: subir los datos y bajar un
 * archivo.
 *
 * Ninguna pide sesión: las abre el enlace que da Claude, firmado y con media
 * hora de vida (ver `r.enlaces`). Quien está hablando con Claude no tiene por
 * qué haber iniciado sesión en la web, y pedírsela sería justo el clic que esto
 * quiere quitar.
 */

const path = require('node:path');
const express = require('express');
const { Router } = require('express');

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ERROR_CODES } = require('../../config/constants');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const {
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require('../../shared/errors/AppError');
const licenseService = require('../licensing/license.service');
const { traeHerramientas } = require('../productos/producto.perfil');
const enlaces = require('./r.enlaces');
const rService = require('./r.service');
const { ArchivoNoValido } = require('./r.formato');
const bibliografia = require('./r.bibliografia');
const { mensajeEnlaceNoVale } = require('../../shared/utils/enlaceNoVale');
const { MotorNoDisponible, MotorOcupado } = require('./r.motor');

const router = Router();

/** Vencido o alterado: cada uno con su mensaje (ver `enlaceNoVale`). */
function enlaceDeSubida(token) {
  try {
    return enlaces.verificarSubida(token);
  } catch (error) {
    throw new NotFoundError(mensajeEnlaceNoVale(error, { para: 'subir tus datos', minutos: enlaces.MINUTOS }));
  }
}

/**
 * El archivo llega como cuerpo crudo.
 *
 * El resto de la API está limitada a 100 KB, que no alcanza para una matriz con
 * muchas columnas. Se abre solo aquí. El tipo no se mira: el formato real se
 * decide leyendo los bytes (ver `r.formato`).
 *
 * Entra hasta el tope de un exporte bibliográfico, que es el mayor; lo que pase
 * del de una matriz y no sea un exporte se para después, con el mismo mensaje.
 */
const TOPE_DE_SUBIDA = Math.max(env.R_SUBIDA_MAX_BYTES, env.R_SUBIDA_BIBLIO_MAX_BYTES);
const cuerpoCrudo = express.raw({ type: () => true, limit: TOPE_DE_SUBIDA });

function demasiadoGrande() {
  const megas = Math.round(env.R_SUBIDA_MAX_BYTES / 1024 / 1024);
  const megasBiblio = Math.round(env.R_SUBIDA_BIBLIO_MAX_BYTES / 1024 / 1024);
  return new ValidationError(
    `El archivo pasa de ${megas} MB. Una matriz de tesis no suele llegar a uno: comprueba ` +
      'que no sea el Excel con gráficos o varias hojas de más. (Un exporte de Scopus o WoS ' +
      `para el mapeo bibliométrico puede llegar a ${megasBiblio} MB.)`,
  );
}

function recibirArchivo(req, res, next) {
  cuerpoCrudo(req, res, (error) => {
    if (error?.type === 'entity.too.large') return next(demasiadoGrande());
    return next(error);
  });
}

/**
 * El mismo criterio que el envío del análisis: licencia vigente de ese método.
 *
 * Y que ese método traiga las herramientas: el Humanizador académico suelto no
 * las trae, y su comprador no tiene por qué poder subir una matriz a una sesión
 * de R que su panel no le ofrece. Ver `productos/producto.perfil`.
 */
async function tieneLicenciaVigente(userId, productCode) {
  const ahora = new Date();
  if (!traeHerramientas(productCode)) return false;
  const licencias = await licenseService.listForUser(userId);
  return licencias.some(
    (l) =>
      l.productCode === productCode &&
      l.status === 'ACTIVE' &&
      (!l.expiresAt || new Date(l.expiresAt) > ahora),
  );
}

// La página pregunta primero si el enlace vale, para no dejar elegir un archivo
// que luego no se va a poder subir.
router.get(
  '/subir/:token',
  asyncHandler(async (req, res) => {
    const enlace = enlaceDeSubida(req.params.token);
    return ok(res, { caduca: enlace.caduca.toISOString(), disponible: rService.disponible() });
  }),
);

/**
 * El enlace se comprueba ANTES de leer el archivo.
 *
 * Al revés, cualquiera con un token inventado hacía que la API se tragara 5 MB
 * en memoria antes de rechazarlo, y con unas cuantas conexiones a la vez eso se
 * nota en un servidor de 3,8 GB.
 */
function exigirEnlace(req, _res, next) {
  try {
    req.enlaceDeR = enlaceDeSubida(req.params.token);
    return next();
  } catch (error) {
    return next(error);
  }
}

router.post(
  '/subir/:token',
  exigirEnlace,
  recibirArchivo,
  asyncHandler(async (req, res) => {
    const { userId, productCode } = req.enlaceDeR;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('No llegó ningún archivo. Elige tu matriz y vuelve a subirla.');
    }
    if (req.body.length > env.R_SUBIDA_MAX_BYTES && !bibliografia.detectar(req.body)) {
      throw demasiadoGrande();
    }
    if (!(await tieneLicenciaVigente(userId, productCode))) {
      throw new ForbiddenError('Tu licencia de este método no está vigente, así que no se puede analizar.');
    }

    try {
      const subido = await rService.subirDatos({ userId, productCode, bytes: req.body });
      return ok(res, subido, {
        message: subido.leido
          ? 'Listo. Vuelve a tu conversación y di que ya subiste tus datos.'
          : 'El archivo llegó, pero R no pudo leerlo como una tabla.',
      });
    } catch (error) {
      if (error instanceof ArchivoNoValido) throw new ValidationError(error.message);
      if (error instanceof MotorOcupado) {
        throw new AppError('Hay mucha gente analizando ahora mismo. Vuelve a subirlo en un minuto.', {
          statusCode: 503,
          code: ERROR_CODES.R_UNAVAILABLE,
        });
      }
      if (error instanceof MotorNoDisponible) {
        // La causa de verdad —permiso, polkit, unidad sin instalar— solo va al
        // registro: al tesista no le sirve y al que lo arregla sí.
        logger.error({ err: error, userId }, 'Subida a R: el motor no está disponible');
        throw new AppError('El análisis en R no está disponible ahora mismo. Inténtalo más tarde.', {
          statusCode: 503,
          code: ERROR_CODES.R_UNAVAILABLE,
        });
      }
      throw error;
    }
  }),
);

const TIPOS = {
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // El proyecto del análisis cualitativo, para ATLAS.ti, NVivo, MAXQDA o QualCoder.
  '.qdpx': 'application/zip',
};

/**
 * Baja un archivo de la sesión. Se enlaza desde la conversación, así que se
 * abre en una pestaña: los fallos van en texto plano, no en JSON.
 */
router.get(
  '/descarga/:token',
  asyncHandler(async (req, res) => {
    let enlace;
    try {
      enlace = enlaces.verificarDescarga(req.params.token);
    } catch (error) {
      return res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send(mensajeEnlaceNoVale(error, { para: 'descargar', minutos: enlaces.MINUTOS }));
    }

    const bytes = await rService.leerArchivo(enlace);
    if (!bytes) {
      return res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('Ese archivo ya no está en la sesión. Vuelve a tu conversación y pide que lo genere otra vez.');
    }

    const nombre = path.posix.basename(enlace.archivo);
    const extension = path.extname(nombre).toLowerCase();

    // Los tres bytes que le dicen a Excel que el CSV es UTF-8: sin ellos,
    // «Sección» sale «SecciÃ³n» en el Excel de Windows.
    const tieneBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const cuerpo =
      extension === '.csv' && !tieneBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;

    res.set({
      'Content-Type': TIPOS[extension] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Cache-Control': 'no-store',
    });
    return res.send(cuerpo);
  }),
);

module.exports = router;
