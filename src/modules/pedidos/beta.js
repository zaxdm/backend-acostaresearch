'use strict';

const env = require('../../config/env');

/**
 * Quién ve lo que todavía no existe para los demás.
 *
 * POR QUÉ UNA LISTA DE CORREOS
 * ----------------------------
 * Las cosas nuevas se prueban con alguien de verdad antes de enseñárselas a
 * todo el que compró. No sirve una copia aparte de la web —lo que se prueba es
 * la de producción, con sus datos y sus licencias— y no sirve tampoco enseñarla
 * a todos, porque a medio hacer resta más de lo que suma.
 *
 * Es el mismo tercer estado que `Plan.soloPara`: activo, pero solo para unos
 * correos. Quien no está en la lista no ve nada y ni siquiera se entera de que
 * hay algo que no ve.
 *
 * VA EN EL `.env` Y NO EN LA BASE
 * -------------------------------
 * Porque es una lista de dos o tres correos que cambia de higos a brevas, y
 * porque así no hay tabla nueva ni pantalla nueva que mantener para algo que
 * está pensado para desaparecer: el día que la función sea de todos, se borra
 * la variable y se quita esta comprobación.
 */

/** Los correos de la variable, en minúsculas. Admite coma, punto y coma o espacios. */
function correosDe(texto) {
  if (!texto) return [];
  return String(texto)
    .split(/[\s,;]+/)
    .map((correo) => correo.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * ¿Ve este correo la revisión con asesor?
 *
 * Sin variable configurada no la ve nadie, que es lo que tiene que pasar en
 * cualquier sitio donde no se haya encendido a propósito.
 */
function enBeta(email) {
  if (!email) return false;
  return correosDe(env.BETA_REVISION_EMAILS).includes(String(email).trim().toLowerCase());
}

module.exports = { correosDe, enBeta };
