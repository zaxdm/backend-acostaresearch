'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * ¿Es un correo desechable (de los que se crean en un minuto y se tiran)?
 *
 * Para qué: el 24-oct llegaron comprobantes falsos desde `@37xiao.com`, un
 * correo temporal. Quien paga de verdad usa su correo de siempre.
 *
 * La lista grande es pública (`correos-desechables.txt`) y se reemplaza entera
 * al actualizarla; los que encontremos nosotros van en EXTRA.
 */
const EXTRA = ['37xiao.com'];

let dominios = null;

function cargar() {
  if (dominios) return dominios;
  const texto = fs.readFileSync(path.join(__dirname, 'correos-desechables.txt'), 'utf8');
  dominios = new Set(
    texto
      .split(/\r?\n/)
      .map((linea) => linea.trim().toLowerCase())
      .filter((linea) => linea && !linea.startsWith('#')),
  );
  for (const dominio of EXTRA) dominios.add(dominio);
  return dominios;
}

/** True si el dominio del correo, o uno del que cuelga, está en la lista. */
function esCorreoDesechable(correo) {
  const dominio = String(correo || '').trim().toLowerCase().split('@')[1];
  if (!dominio) return false;
  const lista = cargar();
  const partes = dominio.split('.');
  // «x.37xiao.com» también: se mira cada dominio padre hasta el de dos partes.
  for (let i = 0; i <= partes.length - 2; i += 1) {
    if (lista.has(partes.slice(i).join('.'))) return true;
  }
  return false;
}

module.exports = { esCorreoDesechable };
