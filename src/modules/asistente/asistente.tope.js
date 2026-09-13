'use strict';

/**
 * Tope de mensajes al día para todo el asistente.
 *
 * El limitador por IP frena a una persona; esto frena la factura. Un script
 * que rote IPs pasa por encima del primero, pero no de este.
 *
 * Vive en memoria y no en la base, a propósito: la base aguanta cinco
 * conexiones y un contador que escribe en cada mensaje sería la forma más cara
 * de proteger algo barato. La contrapartida es que un reinicio del servidor lo
 * pone a cero, lo que como mucho duplica el tope ese día.
 *
 * El día es el de Lima, que es cuando la gente escribe: con el de UTC el
 * contador se reiniciaría a las siete de la tarde.
 */
function crearTopeDiario(maximo, { zona = 'America/Lima', ahora = () => new Date() } = {}) {
  let dia = null;
  let usados = 0;

  const hoy = () => ahora().toLocaleDateString('en-CA', { timeZone: zona });

  return {
    /** Cuenta un mensaje si cabe. 0 = sin tope. */
    intentar() {
      const actual = hoy();
      if (actual !== dia) {
        dia = actual;
        usados = 0;
      }
      if (maximo > 0 && usados >= maximo) return false;
      usados += 1;
      return true;
    },

    usados() {
      return hoy() === dia ? usados : 0;
    },
  };
}

module.exports = { crearTopeDiario };
