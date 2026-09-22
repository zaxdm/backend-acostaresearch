'use strict';

/**
 * El cupo de la membresía: cuántos documentos quedan este mes.
 *
 * POR QUÉ ES UN MÓDULO APARTE Y SIN BASE DE DATOS
 * ----------------------------------------------
 * Porque es la regla que decide si alguien trabaja o no, y es la única parte
 * del servicio que no se puede comprobar mirando el resultado: si la cuenta
 * está mal, el cliente no ve un error, ve que «se le acabaron» diez documentos
 * cuando llevaba tres, o al revés. Aquí no hay consultas ni fechas del sistema
 * —el «ahora» entra por parámetro—, así que se prueba entera.
 *
 * LA VENTANA DE TREINTA DÍAS
 * --------------------------
 * El cupo es «diez documentos al mes», y «el mes» son treinta días contados
 * desde que se activó la membresía, no el mes del calendario.
 *
 * Con el calendario, quien compra el 28 de septiembre tiene diez documentos
 * hasta el 30 y otros diez el día 1: veinte en cuatro días por S/ 29. Con
 * ventanas propias, el primer mes acaba el 28 de octubre y cada mes de
 * membresía vale exactamente un mes.
 *
 * La mensual y la trimestral se diferencian SOLO en cuántas ventanas caben
 * antes de caducar: una y tres. Las dos dan diez al mes.
 */

const DIA = 24 * 60 * 60 * 1000;
const VENTANA_DIAS = 30;
const VENTANA_MS = VENTANA_DIAS * DIA;

/**
 * En qué ventana cae `ahora`, y desde/hasta cuándo va.
 *
 * `numero` empieza en 1 para poder decírselo al cliente («mes 2 de 3»). Una
 * fecha anterior a la activación —un reloj que va atrás, una prueba— cae en la
 * primera: nunca hay ventana cero ni negativa.
 */
function ventanaDe(pack, ahora = new Date()) {
  const inicio = new Date(pack.activatedAt).getTime();
  const transcurrido = Math.max(0, ahora.getTime() - inicio);
  const indice = Math.floor(transcurrido / VENTANA_MS);

  return {
    numero: indice + 1,
    desde: new Date(inicio + indice * VENTANA_MS),
    hasta: new Date(inicio + (indice + 1) * VENTANA_MS),
  };
}

/** Cuántas ventanas de treinta días cubre la membresía. Mensual 1, trimestral 3. */
function ventanasDe(pack) {
  const duracion = new Date(pack.expiresAt).getTime() - new Date(pack.activatedAt).getTime();
  return Math.max(1, Math.round(duracion / VENTANA_MS));
}

/** ¿Sirve hoy? Activa, sin revocar y sin caducar. */
function vigente(pack, ahora = new Date()) {
  if (!pack) return false;
  if (pack.status !== 'ACTIVE') return false;
  return new Date(pack.expiresAt).getTime() > ahora.getTime();
}

/**
 * El cupo de la ventana en curso.
 *
 * `usados` lo cuenta quien llama, mirando las preparaciones de esa ventana: no
 * hay columna de consumidos que pueda quedarse desfasada. Las fallidas no se
 * cuentan, y eso se decide al contarlas, no aquí.
 *
 * `restantes` nunca baja de cero aunque `usados` pase del tope: puede pasarse
 * si un administrador baja el cupo de un plan a mitad de mes, y en ese caso lo
 * correcto es «no te quedan», no un número negativo.
 */
function cupoDe(pack, usados, ahora = new Date()) {
  const ventana = ventanaDe(pack, ahora);

  return {
    total: pack.docsPorMes,
    usados,
    restantes: Math.max(0, pack.docsPorMes - usados),
    ventana: ventana.numero,
    ventanas: ventanasDe(pack),
    renuevaEl: ventana.hasta,
    desde: ventana.desde,
    caducaEl: new Date(pack.expiresAt),
  };
}

/**
 * Lo que se le dice al cliente cuando pide un documento y no puede.
 *
 * Null = sí puede. El mensaje distingue los tres «no» que existen, porque cada
 * uno se arregla de una forma distinta y un «no puedes» a secas no le dice a
 * nadie qué hacer.
 */
function porQueNo(pack, usados, ahora = new Date()) {
  if (!pack) {
    return 'Necesitas una membresía de «Preparar documento» para mandar un trabajo.';
  }
  if (pack.status === 'REVOKED') {
    return 'Tu membresía está anulada. Escríbenos y lo miramos.';
  }
  if (!vigente(pack, ahora)) {
    return 'Tu membresía caducó. Renuévala y sigues donde lo dejaste.';
  }

  const cupo = cupoDe(pack, usados, ahora);
  if (cupo.restantes <= 0) {
    const dias = Math.max(1, Math.ceil((cupo.renuevaEl.getTime() - ahora.getTime()) / DIA));
    return (
      `Ya usaste los ${cupo.total} documentos de este mes. ` +
      `Vuelves a tener ${cupo.total} en ${dias} día${dias === 1 ? '' : 's'}.`
    );
  }

  return null;
}

module.exports = { ventanaDe, ventanasDe, vigente, cupoDe, porQueNo, VENTANA_DIAS };
