'use strict';
const { timingSafeEqual } = require('node:crypto');
function autorizado(header, secreto) {
  if (!secreto || !header) return false;
  const a = Buffer.from(header); const b = Buffer.from(`Bearer ${secreto}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
module.exports = { autorizado };
