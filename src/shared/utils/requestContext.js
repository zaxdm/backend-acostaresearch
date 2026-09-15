'use strict';

const { ipCliente } = require('./ipCliente');

/** Metadatos de la petición que se guardan junto a cada sesión. */
function extractContext(req) {
  return {
    // La del visitante: por la web, `req.ip` es la de Cloudflare.
    ip: ipCliente(req),
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
  };
}

module.exports = { extractContext };
