'use strict';

/**
 * Envoltura única de las respuestas para que el frontend siempre lea
 * la misma forma: { success, data, message } o { success, error }.
 */
function ok(res, data, { status = 200, message } = {}) {
  return res.status(status).json({ success: true, message, data });
}

function created(res, data, message) {
  return ok(res, data, { status: 201, message });
}

function noContent(res) {
  return res.status(204).send();
}

module.exports = { ok, created, noContent };
