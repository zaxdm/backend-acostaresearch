'use strict';

/**
 * El cronograma de vencimientos de las obligaciones mensuales de SUNAT (621),
 * por último dígito del RUC. Así cada mes trae su fecha sin escribirla a mano.
 *
 * Fuente: «Cronograma de obligaciones mensuales – ejercicio 2026», página
 * oficial de SUNAT (sunat.gob.pe/orientacion/cronogramas/2026/
 * cObligacionMensual2026.html), según la R.S. N.° 281-2022/SUNAT. Leído el
 * 21-oct-2026.
 *
 * Solo está el dígito 0 (el RUC de Acosta termina en 0). SUNAT publica el del
 * año siguiente a fin de año: entonces se añade aquí su bloque. En diciembre,
 * si falta, llega un aviso al programador (`tributos.service`).
 *
 * Clave: `año-mes` del PERIODO; valor: el día en que vence (`aaaa-mm-dd`).
 */
const VENCIMIENTOS = {
  0: {
    '2026-1': '2026-02-16',
    '2026-2': '2026-03-16',
    '2026-3': '2026-04-17',
    '2026-4': '2026-05-18',
    '2026-5': '2026-06-15',
    '2026-6': '2026-07-15',
    '2026-7': '2026-08-18',
    '2026-8': '2026-09-15',
    '2026-9': '2026-10-16',
    '2026-10': '2026-11-16',
    '2026-11': '2026-12-17',
    '2026-12': '2027-01-18',
  },
};

/** El último dígito de un RUC, o null. */
function digitoDe(ruc) {
  const d = String(ruc ?? '').trim().slice(-1);
  return /^\d$/.test(d) ? Number(d) : null;
}

/** La fecha de vencimiento del periodo según el cronograma (medianoche UTC, como una columna DATE), o null. */
function vencimientoDelCronograma({ anio, mes }, ruc, tabla = VENCIMIENTOS) {
  const digito = digitoDe(ruc);
  const dia = digito === null ? null : tabla[digito]?.[`${anio}-${mes}`];
  return dia ? new Date(`${dia}T00:00:00Z`) : null;
}

/** Si el cronograma ya tiene cargado algún mes de ese año para el RUC. */
function tieneElAnio(anio, ruc, tabla = VENCIMIENTOS) {
  const digito = digitoDe(ruc);
  if (digito === null || !tabla[digito]) return false;
  return Object.keys(tabla[digito]).some((clave) => clave.startsWith(`${anio}-`));
}

module.exports = { VENCIMIENTOS, vencimientoDelCronograma, tieneElAnio, digitoDe };
