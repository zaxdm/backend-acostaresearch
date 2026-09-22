'use strict';

/**
 * Las rutas de «Preparar documento».
 *
 * Todas con sesión y sobre `req.user.id`: aquí no hay enlaces firmados como en
 * los de subida del conector, porque esto no se usa desde una conversación
 * sino desde la web, y quien entra ya tiene cuenta —la membresía cuelga de
 * ella—. De quién es nunca llega por parámetro.
 *
 * El .docx viaja como cuerpo crudo, igual que en el resto del sitio, con el
 * nombre del archivo en una cabecera: no hay multipart en ninguna parte de este
 * backend y meterlo aquí solo por este módulo traería una dependencia más.
 */

const { Router } = require('express');
const express = require('express');

const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created } = require('../../shared/http/apiResponse');
const { ValidationError } = require('../../shared/errors/AppError');
const { MAXIMO_BYTES } = require('../projects/project.documento');

const prepararService = require('./preparar.service');
const { encargoSchema } = require('./preparar.schema');

const TIPO_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const router = Router();

router.use(authenticate);

/** El nombre que puso el cliente, solo para devolvérselo. Nunca toca el disco. */
function nombreDelArchivo(cabecera) {
  const bruto = String(cabecera ?? '').slice(0, 400);
  if (bruto === '') return 'documento.docx';
  try {
    return decodeURIComponent(bruto).slice(0, 200);
  } catch {
    return bruto.slice(0, 200);
  }
}

const cuerpoDeDocumento = express.raw({
  type: [TIPO_DOCX, 'application/octet-stream'],
  limit: MAXIMO_BYTES,
});

/**
 * Recibe el archivo, traduciendo el «pesa demasiado» de Express.
 *
 * El error de serie es un 413 sin texto y el cliente ve «Error de red» después
 * de subir cuarenta megas. Aquí se le dice cuánto pesa el tope y qué hacer.
 */
function recibirDocumento(req, res, next) {
  cuerpoDeDocumento(req, res, (error) => {
    if (error?.type === 'entity.too.large') {
      return next(
        new ValidationError(
          `Ese archivo pasa de ${MAXIMO_BYTES / 1024 / 1024} MB. Si lleva muchas imágenes, ` +
            'comprímelas en Word («Archivo» → «Comprimir imágenes») y vuelve a subirlo.',
        ),
      );
    }
    return next(error);
  });
}

/** La pantalla entera: membresía, cupo del mes e historial. */
router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await prepararService.panel(req.user.id))),
);

/**
 * Manda un documento a preparar.
 *
 * El servicio y el idioma van en la URL y no en el cuerpo porque el cuerpo ES
 * el archivo: no hay sitio donde meter un JSON al lado sin montar un multipart.
 */
router.post(
  '/:servicio',
  recibirDocumento,
  asyncHandler(async (req, res) => {
    // `safeParse` y no `parse`: un ZodError suelto llega al manejador global
    // como un 500 sin mensaje, y aquí los mensajes están escritos para que los
    // lea una persona («Solo traducimos a español, inglés, portugués y chino»).
    const pedido = encargoSchema.safeParse({
      servicio: String(req.params.servicio ?? '').toUpperCase(),
      idioma: req.query.idioma ?? null,
    });
    if (!pedido.success) {
      throw new ValidationError(pedido.error.issues[0].message);
    }
    const { servicio, idioma } = pedido.data;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ValidationError(
        'No llegó ningún archivo. Elige el .docx de tu documento y vuelve a subirlo.',
      );
    }

    const hecho = await prepararService.encargar({
      userId: req.user.id,
      servicio,
      idioma,
      buffer: req.body,
      nombre: nombreDelArchivo(req.get('X-Nombre-Archivo')),
    });

    return created(res, hecho);
  }),
);

/** Cómo va un trabajo. Es lo que pregunta la web mientras espera. */
router.get(
  '/trabajos/:id',
  asyncHandler(async (req, res) =>
    ok(res, await prepararService.ver({ userId: req.user.id, id: req.params.id })),
  ),
);

/** El .docx terminado. */
router.get(
  '/trabajos/:id/descargar',
  asyncHandler(async (req, res) => {
    const { preparacion, buffer } = await prepararService.descargar({
      userId: req.user.id,
      id: req.params.id,
    });

    const nombre = prepararService.nombreDeDescarga(preparacion);
    res.setHeader('Content-Type', TIPO_DOCX);
    // El nombre lleva paréntesis y tildes: va también en `filename*`, que es la
    // forma que entienden los navegadores sin destrozar los acentos.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="documento.docx"; filename*=UTF-8''${encodeURIComponent(nombre)}`,
    );
    return res.send(buffer);
  }),
);

module.exports = router;
