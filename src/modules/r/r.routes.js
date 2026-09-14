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
const enlaces = require('./r.enlaces');
const rService = require('./r.service');
const { ArchivoNoValido } = require('./r.formato');
const { MotorNoDisponible, MotorOcupado } = require('./r.motor');

const router = Router();

const ENLACE_CADUCADO =
  'Este enlace ya no vale: dura media hora. Pídele a Claude uno nuevo y vuelve a intentarlo.';

/** Un enlace que no vale responde igual que uno caducado, para no dar pistas. */
function enlaceDeSubida(token) {
  try {
    return enlaces.verificarSubida(token);
  } catch {
    throw new NotFoundError(ENLACE_CADUCADO);
  }
}

/**
 * El archivo llega como cuerpo crudo.
 *
 * El resto de la API está limitada a 100 KB, que no alcanza para una matriz con
 * muchas columnas. Se abre solo aquí. El tipo no se mira: el formato real se
 * decide leyendo los bytes (ver `r.formato`).
 */
const cuerpoCrudo = express.raw({ type: () => true, limit: env.R_SUBIDA_MAX_BYTES });

function recibirArchivo(req, res, next) {
  cuerpoCrudo(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      const megas = Math.round(env.R_SUBIDA_MAX_BYTES / 1024 / 1024);
      return next(
        new ValidationError(
          `El archivo pasa de ${megas} MB. Una matriz de tesis no suele llegar a uno: comprueba ` +
            'que no sea el Excel con gráficos o varias hojas de más.',
        ),
      );
    }
    return next(error);
  });
}

/** El mismo criterio que el envío del análisis: licencia vigente de ese método. */
async function tieneLicenciaVigente(userId, productCode) {
  const ahora = new Date();
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

router.post(
  '/subir/:token',
  recibirArchivo,
  asyncHandler(async (req, res) => {
    const { userId, productCode } = enlaceDeSubida(req.params.token);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('No llegó ningún archivo. Elige tu matriz y vuelve a subirla.');
    }
    if (!(await tieneLicenciaVigente(userId, productCode))) {
      throw new ForbiddenError('Tu licencia de este método no está vigente, así que no se puede analizar.');
    }

    try {
      const subido = await rService.subirDatos({ userId, productCode, bytes: req.body });
      return ok(res, subido, {
        message: subido.leido
          ? 'Listo. Vuelve a la conversación con Claude y dile que ya subiste tus datos.'
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
};

/**
 * Baja un archivo de la sesión. Se enlaza desde la conversación, así que se
 * abre en una pestaña: los fallos van en texto plano, no en JSON.
 */
router.get(
  '/descarga/:token',
  asyncHandler(async (req, res) => {
    const noVale = () => res.status(404).type('text/plain; charset=utf-8').send(ENLACE_CADUCADO);

    let enlace;
    try {
      enlace = enlaces.verificarDescarga(req.params.token);
    } catch {
      return noVale();
    }

    const bytes = await rService.leerArchivo(enlace);
    if (!bytes) {
      return res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('Ese archivo ya no está en la sesión. Pídele a Claude que lo vuelva a generar.');
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
