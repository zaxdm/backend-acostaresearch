'use strict';

/**
 * Las decisiones del bot que no dependen de nadie: si está en horario y si la
 * persona pidió hablar con alguien. Aparte para poder probarlas sin base.
 */

/** Minúsculas y sin tildes: «Atención Humana» y «atencion humana» son lo mismo. */
const normalizar = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** «09:30» → 570. Null si no tiene esa forma. */
function aMinutos(hora) {
  const partes = /^(\d{2}):(\d{2})$/.exec(hora ?? '');
  if (!partes) return null;
  const [h, m] = [Number(partes[1]), Number(partes[2])];
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** Día de la semana (1 = lunes … 7 = domingo) y minuto del día, en Lima. */
function ahoraEnLima(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Lima',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(fecha);
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  const dias = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { dia: dias[valor('weekday')], minuto: Number(valor('hour')) * 60 + Number(valor('minute')) };
}

/**
 * Si ahora es horario de atención humana. Con el horario apagado, nunca.
 *
 * Un horario que cruza la medianoche («20:00» a «02:00») también vale: se lee
 * como «desde las ocho hasta las dos».
 */
function enHorarioHumano(ajustes, fecha = new Date()) {
  if (!ajustes?.usarHorario) return false;
  const inicio = aMinutos(ajustes.horaInicio);
  const fin = aMinutos(ajustes.horaFin);
  if (inicio === null || fin === null || inicio === fin) return false;

  const dias = String(ajustes.diasLaborables ?? '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d >= 1 && d <= 7);
  const { dia, minuto } = ahoraEnLima(fecha);
  if (!dias.includes(dia)) return false;

  return inicio < fin ? minuto >= inicio && minuto < fin : minuto >= inicio || minuto < fin;
}

/** Si el mensaje contiene alguna de las frases que piden una persona. */
function pidePersona(texto, palabras) {
  const mensaje = normalizar(texto);
  return String(palabras ?? '')
    .split(',')
    .map(normalizar)
    .filter((frase) => frase.length >= 3)
    .some((frase) => mensaje.includes(frase));
}

/**
 * Si todavía se le puede escribir libremente: Meta solo lo deja en las 24
 * horas siguientes al último mensaje del cliente.
 */
function ventanaAbierta(ultimoDelClienteAt, ahora = Date.now()) {
  if (!ultimoDelClienteAt) return false;
  return ahora - new Date(ultimoDelClienteAt).getTime() < 24 * 60 * 60 * 1000;
}

module.exports = { normalizar, aMinutos, ahoraEnLima, enHorarioHumano, pidePersona, ventanaAbierta };
