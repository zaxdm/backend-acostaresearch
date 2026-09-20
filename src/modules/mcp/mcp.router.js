'use strict';

const { Router } = require('express');
const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node');
const logger = require('../../config/logger');
const { mcpLimiter, mcpFallosLimiter } = require('../../middlewares/rateLimit');
const { ERROR_CODES } = require('../../config/constants');
const licenseService = require('../licensing/license.service');
const { filtro } = require('./mcp.acceso');
const { clienteDe } = require('./mcp.cliente');
const { construirServidor } = require('./mcp.tools');

/**
 * Punto de entrada del conector MCP.
 *
 * La URL que el comprador pega en Claude es `https://.../mcp/<token>`, así que
 * el token viaja en la ruta. Claude llama desde la infraestructura de Anthropic
 * (no desde el equipo del comprador), por lo que este endpoint tiene que ser
 * accesible desde internet y servirse por HTTPS.
 *
 * Va en modo SIN ESTADO: un servidor y un transporte por petición. Es lo que
 * recomienda la especificación de julio de 2026 y además evita que dos
 * compradores compartan objetos en memoria por error. El hilo de conversación
 * no se pierde: lo lleva el parámetro `sesion` de la herramienta `redactar`.
 */

const router = Router();

/** Error en el formato que entiende un cliente MCP. */
function errorJsonRpc(res, status, code, message) {
  return res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

/**
 * Lo que seguro no es una licencia se rechaza aquí, sin consulta. Va delante del
 * límite por licencia para que cada URL inventada no estrene su propio contador.
 */
function descartarSinBase(req, res, next) {
  const { token } = req.params;
  if (!filtro.pareceLicencia(token) || filtro.esDesconocida(token)) {
    return errorJsonRpc(res, 401, -32001, 'Esta licencia no existe.');
  }
  return next();
}

router.post('/:token', mcpFallosLimiter, descartarSinBase, mcpLimiter, async (req, res) => {
  let licencia;

  try {
    licencia = await licenseService.authenticate(req.params.token);
  } catch (error) {
    if (error.code === ERROR_CODES.LICENSE_INVALID) filtro.recordarDesconocida(req.params.token);
    // 401/403 es lo que espera un cliente MCP cuando la credencial no sirve.
    return errorJsonRpc(res, error.statusCode ?? 401, -32001, error.message);
  }

  const transport = new NodeStreamableHTTPServerTransport({
    // Sin sesiones de transporte: cada petición se atiende y se cierra.
    sessionIdGenerator: undefined,
  });

  try {
    // La cabecera dice si es ChatGPT, que necesita los enlaces de otra forma.
    // Viaja en TODAS las peticiones; `clientInfo` del `initialize` no, porque
    // aquí cada llamada es un servidor nuevo.
    const server = construirServidor(licencia, { cliente: clienteDe(req.get('user-agent')) });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ err: error, licenseId: licencia.id }, 'Fallo atendiendo una petición MCP');
    if (!res.headersSent) {
      errorJsonRpc(res, 500, -32603, 'Error interno del conector.');
    }
  } finally {
    // El transporte muere con la petición; si no se cierra, quedan sockets vivos.
    transport.close?.();
  }
});

/**
 * En modo sin estado no hay flujo servidor→cliente que mantener abierto, así que
 * GET y DELETE no aplican. Se responde explícitamente para que el cliente no se
 * quede esperando.
 */
router.all('/:token', (req, res) => {
  if (req.method === 'POST') return;
  return errorJsonRpc(res, 405, -32000, 'Este conector solo acepta POST.');
});

module.exports = router;
