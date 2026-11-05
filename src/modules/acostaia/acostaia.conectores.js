'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { ValidationError } = require('../../shared/errors/AppError');

/**
 * Zotero y Mendeley desde AcostaIA (5-nov-2026).
 *
 * El usuario de AcostaIA no tiene sesión en acostaresearch.com, y conectar
 * Zotero o Mendeley es un intercambio OAuth que necesita que el NAVEGADOR del
 * usuario lo empiece y lo termine (la cookie que ata el intercambio a ese
 * navegador; ver los controladores de Zotero y Mendeley). Así que:
 *
 * 1. El servidor de AcostaIA (con la clave interna) pide un PASE para su
 *    usuario. El pase sirve una sola vez y caduca a los 2 minutos.
 * 2. La web de AcostaIA abre `/acostaia/conectores/ir?pase=…`. Esa ruta no
 *    pide clave: el pase es la identidad. Empieza el intercambio de siempre
 *    (misma cookie, misma comprobación del navegador) y manda a zotero.org o
 *    a mendeley.com.
 * 3. La vuelta de Zotero o Mendeley es la de siempre; solo que, si el
 *    intercambio salió de AcostaIA, devuelve al usuario a AcostaIA
 *    (`ACOSTAIA_URL`) en vez de a su perfil de acostaresearch.com.
 *
 * Riesgo aceptado (ficha del 5-nov): quien le pase a otro su enlace y este lo
 * abra y autorice en esos 2 minutos, se quedaría con su biblioteca. El pase de
 * un solo uso y que caduque tan pronto es lo que lo hace improbable.
 *
 * Los pases y las vueltas viven en memoria: el backend es un solo proceso. Si
 * se reinicia en medio, el usuario vuelve a pulsar «Conectar».
 */

const VIDA_DEL_PASE_MS = 2 * 60 * 1000;
const VIDA_DE_LA_VUELTA_MS = 30 * 60 * 1000;

const pases = new Map(); // pase -> { userId, cual, hasta }
const vueltas = new Map(); // `${cual}:${token o state}` -> hasta

/** Los servicios se piden al usarlos: tiran de medio backend (ver acostaia.datos). */
function servicioDe(cual) {
  if (cual === 'zotero') return require('../zotero/biblioteca.service');
  if (cual === 'mendeley') return require('../mendeley/mendeley.service');
  throw new ValidationError('Ese conector no existe.');
}

function limpiar(mapa, ahora) {
  for (const [clave, valor] of mapa) {
    if ((valor.hasta ?? valor) < ahora) mapa.delete(clave);
  }
}

/** El titular espejo, o un error claro si aún no abrió ningún chat. */
async function titularDe(acostaiaId) {
  const titular = await prisma.user.findUnique({ where: { acostaiaId }, select: { id: true } });
  if (!titular) {
    throw new ValidationError('Abre tu primer chat en AcostaIA y vuelve aquí para conectar tus fuentes.');
  }
  return titular;
}

const conectores = {
  /** Cómo está cada uno. Sin titular todavía: ninguno conectado. */
  async estado({ acostaiaId }) {
    const titular = await prisma.user.findUnique({ where: { acostaiaId }, select: { id: true } });
    if (!titular) {
      return {
        zotero: { disponible: env.zoteroOauthEnabled, conectado: false },
        mendeley: { disponible: env.mendeleyOauthEnabled, conectado: false },
      };
    }
    const [zotero, mendeley] = await Promise.all([
      servicioDe('zotero').estado(titular.id),
      servicioDe('mendeley').estado(titular.id),
    ]);
    return { zotero, mendeley };
  },

  /** Paso 1: el pase y la dirección que abre la web de AcostaIA. */
  async pase({ acostaiaId, cual }, ahora = Date.now()) {
    if (!env.ACOSTAIA_URL) {
      throw new ValidationError('Conectar desde AcostaIA no está configurado en este servidor.');
    }
    servicioDe(cual);
    const titular = await titularDe(acostaiaId);
    limpiar(pases, ahora);
    const pase = crypto.randomBytes(24).toString('base64url');
    pases.set(pase, { userId: titular.id, cual, hasta: ahora + VIDA_DEL_PASE_MS });
    return { url: `${env.APP_URL}${env.API_PREFIX}/acostaia/conectores/ir?pase=${pase}` };
  },

  /**
   * Paso 2: canjea el pase (una vez) y empieza el intercambio de siempre.
   * Devuelve la dirección de Zotero o Mendeley y la marca que el controlador
   * deja en la cookie del navegador.
   */
  async ir(pase, ahora = Date.now()) {
    const dato = pases.get(pase);
    pases.delete(pase);
    if (!dato || dato.hasta < ahora) {
      throw new ValidationError('Este enlace ya se usó o caducó. Vuelve a AcostaIA y pulsa «Conectar» otra vez.');
    }
    const empezado = await servicioDe(dato.cual).empezar(dato.userId);
    const marca = empezado.token ?? empezado.state;
    limpiar(vueltas, ahora);
    vueltas.set(`${dato.cual}:${marca}`, ahora + VIDA_DE_LA_VUELTA_MS);
    return { cual: dato.cual, url: empezado.url, marca };
  },

  /** En la vuelta: ¿este intercambio salió de AcostaIA? Se responde una vez. */
  esDeAcostaIA(cual, marca) {
    if (!marca) return false;
    const clave = `${cual}:${marca}`;
    const hasta = vueltas.get(clave);
    vueltas.delete(clave);
    return Boolean(hasta && hasta >= Date.now());
  },

  /** A dónde vuelve el usuario de AcostaIA, con el resultado en la dirección. */
  urlDeVuelta(cual, resultado) {
    return `${env.ACOSTAIA_URL}/personalizacion?ver=conectores&${cual}=${resultado}`;
  },

  /** Lo de después de conectar: elegir colección o carpeta, traer y desconectar. */
  async colecciones({ acostaiaId, cual }) {
    const { id } = await titularDe(acostaiaId);
    const s = servicioDe(cual);
    return cual === 'zotero' ? s.colecciones(id) : s.carpetas(id);
  },

  async elegir({ acostaiaId, cual, clave }) {
    const { id } = await titularDe(acostaiaId);
    return servicioDe(cual).elegir(id, clave);
  },

  async sincronizar({ acostaiaId, cual }) {
    const { id } = await titularDe(acostaiaId);
    return servicioDe(cual).sincronizar(id);
  },

  async desconectar({ acostaiaId, cual }) {
    const { id } = await titularDe(acostaiaId);
    return servicioDe(cual).desconectar(id);
  },
};

module.exports = conectores;
