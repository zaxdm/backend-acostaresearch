'use strict';

const express = require('express');

const { Router } = express;
const env = require('../../config/env');
const logger = require('../../config/logger');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok, created, noContent } = require('../../shared/http/apiResponse');
const imagenesStorage = require('./whatsapp.imagenes');
const { ROLES } = require('../../config/constants');
const meta = require('./whatsapp.meta');
const whatsappService = require('./whatsapp.service');
const {
  ajustesSchema,
  idParamSchema,
  listarQuerySchema,
  responderSchema,
  subirImagenQuerySchema,
  editarImagenSchema,
  modoSchema,
  bloqueoSchema,
  simularSchema,
} = require('./whatsapp.schema');

// ── El webhook de Meta ───────────────────────────────────────────────────────
//
// Público —lo llama Meta— y montado en `app.js` ANTES del límite global: los
// avisos llegan desde pocas IP de Meta, uno por mensaje y otro por cada
// «entregado» y «leído», y con el límite por IP un día movido cortaría los
// mensajes de todos. Lo que protege esto es la firma, no el límite.

const webhook = Router();

/**
 * La verificación: al guardar el webhook en Meta, llama aquí con el token que
 * se pegó allí y espera que se le devuelva el `challenge` tal cual.
 */
webhook.get('/', (req, res) => {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const reto = req.query['hub.challenge'];
  if (modo === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp: webhook verificado por Meta');
    return res.status(200).type('text/plain').send(String(reto ?? ''));
  }
  return res.sendStatus(403);
});

/**
 * Los mensajes. Se contesta 200 en cuanto la firma vale y se atiende después:
 * Meta reintenta si tarda, y Gemini puede tardar varios segundos.
 */
webhook.post('/', (req, res) => {
  if (!meta.firmaValida(req.rawBody, req.get('x-hub-signature-256'))) {
    logger.warn('WhatsApp: aviso con firma inválida, descartado');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  whatsappService.recibirAviso(req.body);
  return undefined;
});

// ── El panel (solo ADMIN) ────────────────────────────────────────────────────

const panel = Router();
panel.use(authenticate, authorize(ROLES.ADMIN));

panel.get(
  '/estado',
  asyncHandler(async (_req, res) => ok(res, await whatsappService.estado())),
);

panel.get(
  '/ajustes',
  asyncHandler(async (_req, res) => ok(res, await whatsappService.ajustes())),
);

panel.put(
  '/ajustes',
  validate({ body: ajustesSchema }),
  asyncHandler(async (req, res) => ok(res, await whatsappService.guardarAjustes(req.body))),
);

panel.get(
  '/conversaciones',
  validate({ query: listarQuerySchema }),
  asyncHandler(async (req, res) => ok(res, await whatsappService.listar(req.query))),
);

panel.get(
  '/conversaciones/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => ok(res, await whatsappService.abrir(req.params.id))),
);

panel.post(
  '/conversaciones/:id/responder',
  validate({ params: idParamSchema, body: responderSchema }),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await whatsappService.responder(req.params.id, req.body.texto, req.user.id, req.body.imagenId),
    ),
  ),
);

// ── La galería de imágenes ───────────────────────────────────────────────────

panel.get(
  '/imagenes',
  asyncHandler(async (_req, res) => ok(res, await whatsappService.imagenes())),
);

/**
 * Subir una imagen: el archivo va crudo en el cuerpo y sus datos en la
 * dirección, como los comprobantes. El techo de 100 KB del resto de la API se
 * abre solo aquí; el formato real lo comprueba `whatsapp.imagenes` por sus bytes.
 */
panel.post(
  '/imagenes',
  express.raw({ type: ['image/png', 'image/jpeg'], limit: imagenesStorage.MAX_BYTES }),
  validate({ query: subirImagenQuerySchema }),
  asyncHandler(async (req, res) =>
    created(res, await whatsappService.subirImagen(req.body, req.query), 'Imagen guardada.'),
  ),
);

panel.put(
  '/imagenes/:id',
  validate({ params: idParamSchema, body: editarImagenSchema }),
  asyncHandler(async (req, res) => ok(res, await whatsappService.editarImagen(req.params.id, req.body))),
);

panel.delete(
  '/imagenes/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    await whatsappService.borrarImagen(req.params.id);
    return noContent(res);
  }),
);

/** La imagen tal cual, para verla en el panel. Se pide con el token, como blob. */
panel.get(
  '/imagenes/:id/archivo',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { buffer, mime } = await whatsappService.archivoImagen(req.params.id);
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buffer);
  }),
);

panel.put(
  '/conversaciones/:id/modo',
  validate({ params: idParamSchema, body: modoSchema }),
  asyncHandler(async (req, res) =>
    ok(res, await whatsappService.cambiarModo(req.params.id, req.body.modo)),
  ),
);

panel.put(
  '/conversaciones/:id/bloqueo',
  validate({ params: idParamSchema, body: bloqueoSchema }),
  asyncHandler(async (req, res) =>
    ok(res, await whatsappService.bloquear(req.params.id, req.body.bloqueado)),
  ),
);

panel.delete(
  '/conversaciones/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    await whatsappService.borrar(req.params.id);
    return noContent(res);
  }),
);

panel.post(
  '/simular',
  validate({ body: simularSchema }),
  asyncHandler(async (req, res) => ok(res, await whatsappService.simular(req.body))),
);

module.exports = { webhook, panel };
