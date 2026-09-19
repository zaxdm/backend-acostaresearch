'use strict';

/**
 * La puerta para subir las entrevistas, sin sesión.
 *
 * La abre el enlace que da Claude con «analisis_cualitativo», firmado y con
 * media hora de vida (ver `cualitativo.enlaces`). Mismo esquema que el material
 * del curso: un archivo por petición, y la página los manda de uno en uno.
 */

const express = require('express');
const { Router } = require('express');

const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const { ForbiddenError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { mensajeEnlaceNoVale } = require('../../shared/utils/enlaceNoVale');
const licenseService = require('../licensing/license.service');
const enlaces = require('./cualitativo.enlaces');
const cualitativoService = require('./cualitativo.service');
const { EntrevistaNoValida, MAXIMO_BYTES } = require('./cualitativo.lectura');

const router = Router();

function enlaceDeSubida(token) {
  try {
    return enlaces.verificar(token);
  } catch (error) {
    throw new NotFoundError(mensajeEnlaceNoVale(error, { para: 'subir tus entrevistas', minutos: enlaces.MINUTOS }));
  }
}

/** El resto de la API está limitada a 100 KB; una transcripción en PDF pesa más. Se abre solo aquí. */
const cuerpoCrudo = express.raw({ type: () => true, limit: MAXIMO_BYTES });

function recibirArchivo(req, res, next) {
  cuerpoCrudo(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return next(new ValidationError(`Ese archivo pasa de ${MAXIMO_BYTES / 1024 / 1024} MB.`));
    }
    return next(error);
  });
}

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

/** El nombre del archivo, para enseñarlo. Nunca se usa para escribir en disco. */
function decodificar(cabecera) {
  const bruto = String(cabecera ?? '').slice(0, 400);
  if (bruto === '') return null;
  try {
    return decodeURIComponent(bruto).slice(0, 200);
  } catch {
    return bruto.slice(0, 200);
  }
}

router.get(
  '/entrevistas/:token',
  asyncHandler(async (req, res) => {
    const enlace = enlaceDeSubida(req.params.token);
    const entrevistas = await cualitativoService.lista(enlace.userId, enlace.productCode);
    return ok(res, { caduca: enlace.caduca.toISOString(), entrevistas });
  }),
);

router.post(
  '/entrevistas/:token',
  recibirArchivo,
  asyncHandler(async (req, res) => {
    const { userId, productCode } = enlaceDeSubida(req.params.token);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError('No llegó ningún archivo. Elígelo y vuelve a intentarlo.');
    }
    if (!(await tieneLicenciaVigente(userId, productCode))) {
      throw new ForbiddenError('Tu licencia no está vigente, así que no se pueden guardar las entrevistas.');
    }

    try {
      const guardada = await cualitativoService.guardar({
        userId,
        productCode,
        buffer: req.body,
        nombre: decodificar(req.get('X-Nombre-Archivo')),
      });
      if (!guardada) {
        throw new ForbiddenError('Tu licencia no está vigente, así que no se pueden guardar las entrevistas.');
      }
      const aviso =
        guardada.citasPerdidas > 0
          ? ` Reemplazó a la anterior, y sus ${guardada.citasPerdidas} citas codificadas se quitaron: habrá que volver a codificarla.`
          : '';
      return ok(
        res,
        { entrevistas: guardada.lista },
        { message: `«${guardada.nombre}» guardada como ${guardada.id}, con ${guardada.parrafos} párrafos.${aviso}` },
      );
    } catch (error) {
      // Los mensajes de la lectura están escritos para el tesista: van tal cual.
      if (error instanceof EntrevistaNoValida) throw new ValidationError(error.message);
      throw error;
    }
  }),
);

module.exports = router;
