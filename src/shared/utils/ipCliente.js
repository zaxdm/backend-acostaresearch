'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const env = require('../../config/env');

/**
 * La IP del visitante, para contar los límites por IP.
 *
 * POR QUÉ NO BASTA CON `req.ip`
 * ------------------------------
 * Caddy no se fía del X-Forwarded-For que le llega: lo reemplaza por la IP que
 * ve. Así nadie elige su IP llamando directo a la API, pero para la web —que
 * pasa por el Worker de Cloudflare— la IP que ve Caddy es la de Cloudflare, la
 * misma para muchos visitantes a la vez. Comprobado contra producción el 15 de
 * septiembre de 2026: dos visitas por la web cayeron en cubos que ya llevaban
 * gastadas peticiones de otros. Con treinta intentos de acceso por cuarto de
 * hora por cubo, gente de verdad se quedaba con un 429 al entrar.
 *
 * El Worker manda aparte la IP del visitante y un secreto que solo conocen él
 * y este backend. Sin el secreto, la cabecera no vale nada: quien llame directo
 * a la API no puede elegir con qué IP se le cuenta.
 */

function mismoSecreto(recibido, esperado) {
  const a = Buffer.from(String(recibido));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ipCliente(req) {
  if (env.PROXY_SECRET && mismoSecreto(req.get('x-acosta-proxy') ?? '', env.PROXY_SECRET)) {
    const ip = String(req.get('x-cliente-ip') ?? '').trim();
    if (net.isIP(ip)) return ip;
  }
  return req.ip;
}

module.exports = { ipCliente };
