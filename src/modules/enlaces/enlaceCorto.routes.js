'use strict';

/**
 * `/s/<código>` — la puerta de los enlaces cortos.
 *
 * Va fuera del prefijo de la API y sin `/api/v1` delante a propósito: cuanto
 * más corta la dirección, menos tiene que copiar el asistente, que es el
 * problema entero que esto viene a resolver.
 *
 * LA PÁGINA DE ERROR ESTÁ AQUÍ Y NO EN LA WEB
 * -------------------------------------------
 * Cuando el código no vale no sabemos de qué tipo de enlace era —ese dato vive
 * en el destino, que es lo que no hemos podido leer—, así que no se puede
 * mandar al tesista a la página de la web que le correspondía. Se le contesta
 * aquí, con el mismo texto que leería allí.
 */

const { Router } = require('express');

const logger = require('../../config/logger');
const { textoEnlaceNoVale } = require('../../shared/utils/enlaceNoVale');
const enlaceCorto = require('./enlaceCorto.service');

const router = Router();

/** Una de cada tantas resoluciones aprovecha para tirar lo viejo. */
const LIMPIA_UNA_DE_CADA = 50;

const escapar = (t) =>
  String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** La misma cara que la página de la web: tarjeta blanca y el aviso en rojo. */
const pagina = (mensaje) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Este enlace ya no vale · Acosta | IA &amp; Research</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f4f6fb; color: #0f172a; padding: 24px;
         font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .tarjeta { background: #fff; border-radius: 16px; padding: 32px; max-width: 560px; width: 100%;
             box-shadow: 0 10px 30px rgba(15, 23, 42, .08); }
  .encima { color: #2563eb; font-size: 12px; font-weight: 700; letter-spacing: .08em;
            text-transform: uppercase; margin: 0 0 12px; }
  h1 { font-size: 28px; margin: 0 0 20px; }
  .aviso { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
           border-radius: 10px; padding: 16px; margin: 0 0 16px; line-height: 1.5; }
  .pie { color: #475569; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="tarjeta">
    <p class="encima">Desde tu conversación</p>
    <h1>Este enlace ya no vale</h1>
    <p class="aviso">${escapar(mensaje)}</p>
    <p class="pie">Vuelve a tu conversación y pide un enlace nuevo.</p>
  </div>
</body>
</html>`;

router.get('/:codigo', async (req, res) => {
  let resultado;
  try {
    resultado = await enlaceCorto.resolver(req.params.codigo);
  } catch (error) {
    logger.error({ err: error }, 'Fallo resolviendo un enlace corto');
    // Un fallo de la base no es culpa del enlace: no se le dice que está roto.
    return res.status(503).type('html').send(pagina(
      'Ahora mismo no podemos abrir tu enlace. Inténtalo en un minuto; si sigue igual, ' +
      'vuelve a tu conversación y pide uno nuevo.',
    ));
  }

  if (Math.floor(Math.random() * LIMPIA_UNA_DE_CADA) === 0) {
    enlaceCorto.limpiar().catch((error) => logger.warn({ err: error }, 'No se pudo limpiar enlaces cortos'));
  }

  if (resultado.destino) {
    // Sin caché: el mismo código no puede quedarse guardado en ningún sitio,
    // y cuando venza tiene que volver a preguntar para leer «venció».
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, resultado.destino);
  }

  return res
    .status(404)
    .type('html')
    .send(pagina(textoEnlaceNoVale(resultado.motivo === 'vencido')));
});

module.exports = router;
