'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { avisarAlAdmin } = require('../../lib/notify');

/**
 * Los interruptores del piloto: quién lo ve y si avisa.
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

/**
 * Un aviso al móvil, pero solo si el piloto ya avisa.
 *
 * POR QUÉ ESTÁ APAGADO MIENTRAS SE PRUEBA
 * ---------------------------------------
 * Porque las pruebas de uno mismo no son noticias. Mientras se prueba, cada
 * ficha y cada encargo los provoca quien está probando, y el tópico se llena de
 * avisos que nadie tiene que atender: eso enseña a no mirarlos, y el día que
 * llegue uno de verdad —un Yape esperando, un comprador atascado— se perderá
 * entre el ruido. Lo que se protege aquí no es el teléfono, es que los avisos
 * sigan significando algo.
 *
 * Callado no es perdido: queda en el log, que es donde se mira cuando alguien
 * pregunta si algo llegó. Se enciende con `AVISOS_REVISION=true` en el .env y
 * un reinicio; no hace falta desplegar.
 */
function avisarDelPiloto(aviso) {
  if (!env.AVISOS_REVISION) {
    logger.info({ aviso }, 'Aviso del piloto de revisión (silenciado)');
    return;
  }
  avisarAlAdmin(aviso);
}

module.exports = { correosDe, enBeta, avisarDelPiloto };
