'use strict';

const { Router } = require('express');
const { z } = require('zod');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../shared/http/asyncHandler');
const { ok } = require('../../shared/http/apiResponse');
const env = require('../../config/env');
const avisosService = require('./avisos.service');

/**
 * Correos de avance: la baja desde el correo y el interruptor del perfil.
 *
 * La baja son DOS pasos a propósito. El enlace del correo enseña un botón, y
 * solo el botón (`&confirmar=1`) desactiva: los filtros de seguridad de los
 * correos de empresa y universidad abren los enlaces del correo para mirarlos,
 * y si bastara con abrirlo, el antivirus de la universidad daría de baja a sus
 * alumnos sin que nadie pulsara nada.
 *
 * El botón es un enlace y no un formulario: un POST desde esta página llevaría
 * como origen la propia API, que el CORS global no admite. El POST queda para
 * el «Anular suscripción» de Gmail (RFC 8058), que llega sin origen.
 */
const router = Router();

const bajaSchema = z.object({
  u: z.string().uuid(),
  t: z.string().min(10).max(100),
  confirmar: z.literal('1').optional(),
});

const HECHO = (titulo) =>
  pagina(
    titulo,
    '<p style="font-size:15px;line-height:1.6">Ya no te mandaremos recordatorios de avance. Si cambias de idea, puedes volver a activarlos desde tu perfil, en «Ayuda».</p>',
  );

function pagina(titulo, cuerpo) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${titulo} · Acosta Research</title></head>
<body style="margin:0;background:#eef0f4;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a2233">
<main style="max-width:480px;margin:48px auto;padding:32px 28px;background:#fff;border:1px solid #e2e5ea;border-radius:14px">
<h1 style="margin:0 0 16px;font-size:21px">${titulo}</h1>${cuerpo}
<p style="margin:24px 0 0;font-size:13px"><a href="${env.APP_URL}" style="color:#1a56db">acostaresearch.com</a></p>
</main></body></html>`;
}

const NO_VALE = pagina(
  'Este enlace no es válido',
  '<p style="font-size:15px;line-height:1.6">Puede que se haya copiado incompleto. Puedes desactivar los recordatorios desde tu perfil, en «Ayuda».</p>',
);

router.get(
  '/baja',
  validate({ query: bajaSchema }),
  asyncHandler(async (req, res) => {
    const { u, t, confirmar } = req.query;
    res.set('Cache-Control', 'no-store');
    if (confirmar) {
      const hecho = await avisosService.darDeBaja(u, t);
      return hecho ? res.send(HECHO('Listo')) : res.status(400).send(NO_VALE);
    }
    if (!avisosService.firmaValida(u, t)) return res.status(400).send(NO_VALE);
    const accion = `${env.API_PREFIX}/avisos/baja?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}&confirmar=1`;
    return res.send(
      pagina(
        '¿Dejar de recibir recordatorios?',
        `<p style="font-size:15px;line-height:1.6">Son los correos que te avisan si llevas días sin avanzar, si te falta el formato o si tu acceso está por terminar. Los de tus compras te seguirán llegando.</p>
<p><a href="${accion}" rel="nofollow" style="display:inline-block;padding:11px 20px;background:#1a56db;color:#fff;border-radius:9px;font-size:15px;font-weight:600;text-decoration:none">Sí, desactivarlos</a></p>`,
      ),
    );
  }),
);

router.post(
  '/baja',
  validate({ query: bajaSchema }),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const hecho = await avisosService.darDeBaja(req.query.u, req.query.t);
    return hecho ? res.send(HECHO('Listo')) : res.status(400).send(NO_VALE);
  }),
);

router.get(
  '/preferencia',
  authenticate,
  asyncHandler(async (req, res) => ok(res, await avisosService.preferencia(req.user.id))),
);

router.put(
  '/preferencia',
  authenticate,
  validate({ body: z.object({ activos: z.boolean() }) }),
  asyncHandler(async (req, res) =>
    ok(res, await avisosService.cambiarPreferencia(req.user.id, req.body.activos)),
  ),
);

module.exports = router;
