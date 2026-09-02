'use strict';

/** Metadatos de la petición que se guardan junto a cada sesión. */
function extractContext(req) {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
  };
}

module.exports = { extractContext };
