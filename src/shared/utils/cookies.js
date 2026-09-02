'use strict';

const env = require('../../config/env');
const { REFRESH_COOKIE_NAME } = require('../../config/constants');

function baseOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // 'lax' basta mientras API y SPA compartan sitio; en dominios distintos
    // hace falta 'none' + secure:true (COOKIE_SECURE=true en producción).
    sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: env.refreshCookiePath,
  };
}

function setRefreshCookie(res, token, expiresAt) {
  res.cookie(REFRESH_COOKIE_NAME, token, { ...baseOptions(), expires: expiresAt });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions());
}

function readRefreshCookie(req) {
  return req.cookies?.[REFRESH_COOKIE_NAME];
}

module.exports = { setRefreshCookie, clearRefreshCookie, readRefreshCookie };
