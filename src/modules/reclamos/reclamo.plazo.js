'use strict';

/**
 * Las cuentas del Libro de Reclamaciones: el plazo y el número de cada hoja.
 *
 * Todo se cuenta en hora de Lima. El servidor está en otro huso, y una hoja
 * presentada un viernes a las once de la noche es del viernes para quien la
 * escribe, aunque en UTC ya sea sábado: contarla desde el sábado le daría al
 * proveedor un día hábil que el reglamento no le da.
 */

/** Días hábiles para responder (D.S. 011-2011-PCM, modificado por el 101-2022-PCM). */
const PLAZO_DIAS_HABILES = 15;

const ZONA = 'America/Lima';
const UN_DIA_MS = 24 * 60 * 60 * 1000;
const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 0 domingo … 6 sábado, del día que es en Lima. */
function diaDeLaSemanaEnLima(fecha) {
  const nombre = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: ZONA }).format(fecha);
  return DIAS.indexOf(nombre);
}

/**
 * El último día para responder.
 *
 * Solo se saltan sábados y domingos, NO los feriados. Es a propósito: saltarse
 * un feriado alarga el plazo, y una lista de feriados incompleta —se añaden por
 * ley casi cada año— daría una fecha posterior a la real. Sin ellos la fecha
 * sale igual o antes que la legal, que es el lado bueno para equivocarse.
 *
 * Sumar veinticuatro horas es exacto porque Lima no cambia de hora.
 */
function sumarDiasHabiles(desde, dias = PLAZO_DIAS_HABILES) {
  const fecha = new Date(desde.getTime());
  let quedan = dias;

  while (quedan > 0) {
    fecha.setTime(fecha.getTime() + UN_DIA_MS);
    const dia = diaDeLaSemanaEnLima(fecha);
    if (dia !== 0 && dia !== 6) quedan -= 1;
  }

  return fecha;
}

function anioEnLima(fecha) {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: ZONA }).format(fecha);
}

/**
 * «000000001-2026», como en el anexo del reglamento.
 *
 * El correlativo es el de toda la vida del libro y no vuelve a empezar en enero:
 * el año acompaña para leerlo, pero el número por sí solo ya no se repite.
 */
function codigoDeHoja(numero, fecha) {
  return `${String(numero).padStart(9, '0')}-${anioEnLima(fecha)}`;
}

/** «13 de octubre de 2026», o con la hora, para los correos. */
function fechaEnLima(fecha, { conHora = false } = {}) {
  try {
    return fecha.toLocaleString('es-PE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      ...(conHora ? { hour: '2-digit', minute: '2-digit' } : {}),
      timeZone: ZONA,
    });
  } catch {
    return fecha.toISOString().slice(0, conHora ? 16 : 10).replace('T', ' ');
  }
}

module.exports = { PLAZO_DIAS_HABILES, sumarDiasHabiles, codigoDeHoja, fechaEnLima };
