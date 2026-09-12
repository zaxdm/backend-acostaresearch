'use strict';

const crypto = require('node:crypto');
const env = require('../../config/env');

/**
 * Guardar un secreto de otra persona.
 *
 * Hasta ahora este servidor no guardaba ninguno: las claves que usa —Zotero,
 * PayPal, el correo— son suyas y viven en el `.env`, fuera de la base y fuera
 * del repositorio. La conexión de Zotero de cada tesista cambia eso, y una
 * clave de API ajena en una columna de texto plano es un incidente esperando
 * a que alguien se lleve un volcado del respaldo.
 *
 * AES-256-GCM y no AES-CBC: GCM autentica además de cifrar. Sin autenticación,
 * un atacante que pueda escribir en la base puede alterar el texto cifrado y el
 * descifrado devuelve basura sin quejarse; con GCM, el descifrado falla. Aquí
 * eso importa poco —una clave alterada simplemente no funcionaría contra
 * Zotero— pero es la elección por defecto correcta y no cuesta nada.
 *
 * EL FORMATO GUARDADO
 * -------------------
 *   v1:<iv en base64>:<etiqueta en base64>:<cifrado en base64>
 *
 * Va todo en una sola columna, con su versión delante. El día que haya que
 * rotar el algoritmo, `v2:` convive con `v1:` y se descifra lo viejo mientras
 * se reescribe; sin ese prefijo, un cambio de formato obliga a migrar la tabla
 * entera de una vez y a acertar a la primera.
 *
 * EL IV NUNCA SE REPITE
 * ---------------------
 * Se sortean 12 bytes nuevos en cada cifrado. En GCM, repetir el par (clave,
 * IV) con dos textos distintos rompe el cifrado de verdad, no en teoría: se
 * puede recuperar la diferencia entre ambos. Doce bytes aleatorios por cada
 * llamada es lo que recomienda el propio modo.
 */

const ALGORITMO = 'aes-256-gcm';
const BYTES_IV = 12;
const VERSION = 'v1';

/**
 * La clave, en 32 bytes.
 *
 * Se acepta en hexadecimal (64 caracteres) o en base64, que es lo que sale de
 * `openssl rand -base64 32` y de `openssl rand -hex 32`. Cualquier otra cosa
 * —una contraseña escrita a mano, por ejemplo— se rechaza a propósito: una
 * frase corta como clave de AES es la forma silenciosa de no tener cifrado.
 */
function clave() {
  const bruta = env.SECRETS_KEY;
  if (!bruta) {
    throw new Error(
      'SECRETS_KEY no está configurada: sin ella no se puede guardar la clave de Zotero de nadie.',
    );
  }

  const bytes = /^[0-9a-fA-F]{64}$/.test(bruta)
    ? Buffer.from(bruta, 'hex')
    : Buffer.from(bruta, 'base64');

  if (bytes.length !== 32) {
    throw new Error(
      `SECRETS_KEY tiene ${bytes.length} bytes y hacen falta 32. ` +
        'Genérala con «openssl rand -base64 32».',
    );
  }

  return bytes;
}

/** ¿Se puede cifrar? Para no ofrecer una función que va a fallar al guardar. */
function configurado() {
  try {
    clave();
    return true;
  } catch {
    return false;
  }
}

function cifrar(texto) {
  if (typeof texto !== 'string' || texto === '') {
    throw new Error('No hay nada que cifrar.');
  }

  const iv = crypto.randomBytes(BYTES_IV);
  const cifrador = crypto.createCipheriv(ALGORITMO, clave(), iv);
  const cifrado = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);

  return [
    VERSION,
    iv.toString('base64'),
    cifrador.getAuthTag().toString('base64'),
    cifrado.toString('base64'),
  ].join(':');
}

function descifrar(guardado) {
  if (typeof guardado !== 'string') throw new Error('No hay nada que descifrar.');

  const [version, iv, etiqueta, cifrado] = guardado.split(':');
  if (version !== VERSION || !iv || !etiqueta || !cifrado) {
    throw new Error('El secreto guardado no tiene el formato esperado.');
  }

  const descifrador = crypto.createDecipheriv(
    ALGORITMO,
    clave(),
    Buffer.from(iv, 'base64'),
  );
  descifrador.setAuthTag(Buffer.from(etiqueta, 'base64'));

  return Buffer.concat([
    descifrador.update(Buffer.from(cifrado, 'base64')),
    descifrador.final(),
  ]).toString('utf8');
}

/**
 * Los últimos cuatro caracteres, para enseñar cuál es sin enseñarla.
 *
 * Lo que NUNCA se hace es devolver la clave al frontend, ni siquiera con
 * asteriscos delante: una clave enmascarada en el navegador sigue viajando
 * entera por la red y sigue quedando en el historial de peticiones.
 */
function pista(texto) {
  return typeof texto === 'string' && texto.length >= 4 ? `…${texto.slice(-4)}` : '…';
}

module.exports = { cifrar, descifrar, configurado, pista };
