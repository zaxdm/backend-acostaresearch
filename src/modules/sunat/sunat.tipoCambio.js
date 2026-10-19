'use strict';

/**
 * Tipo de cambio del dólar que publica SUNAT cada día, para pasar a soles lo
 * cobrado en dólares.
 *
 * SUNAT deja el del día en un texto plano: `19/10/2026|3.423|3.431|` (fecha,
 * compra, venta). Solo da el de HOY, así que cada lectura se guarda en memoria
 * por fecha: como la boleta sale a los pocos minutos del cobro, casi siempre se
 * tiene el del día de la venta. Si no (venta justo antes de medianoche y el
 * servidor reiniciado), se usa el último leído; el tipo usado queda en la
 * boleta. Se usa el de VENTA.
 */

const URL_TIPO_CAMBIO = 'https://www.sunat.gob.pe/a/txt/tipoCambio.txt';
const ESPERA_MS = 10 * 1000;

/** Tipo de venta leído, por fecha `aaaa-mm-dd`. */
const leidos = new Map();

/** `19/10/2026|3.423|3.431|` → `{ fecha: '2026-10-19', venta: 3.431 }`, o null. */
function leerTexto(texto) {
  const partes = /^\s*(\d{2})\/(\d{2})\/(\d{4})\|([\d.]+)\|([\d.]+)\|/.exec(texto ?? '');
  if (!partes) return null;
  const [, dia, mes, anio, , venta] = partes;
  const numero = Number(venta);
  if (!(numero > 0)) return null;
  return { fecha: `${anio}-${mes}-${dia}`, venta: numero };
}

/** Lee el de hoy de SUNAT y lo guarda. Nunca lanza: devuelve null si falla. */
async function actualizar(fetchFn = fetch) {
  try {
    const respuesta = await fetchFn(URL_TIPO_CAMBIO, { signal: AbortSignal.timeout(ESPERA_MS) });
    const leido = leerTexto(await respuesta.text());
    if (leido) leidos.set(leido.fecha, leido.venta);
    return leido;
  } catch {
    return null;
  }
}

/**
 * El tipo de cambio para una venta del día `fecha` (`aaaa-mm-dd`, Lima): el
 * de ese día si se leyó; si no, el último leído. Null si nunca se pudo leer.
 */
function para(fecha) {
  if (leidos.has(fecha)) return leidos.get(fecha);
  const ultimo = [...leidos.keys()].sort().pop();
  return ultimo ? leidos.get(ultimo) : null;
}

module.exports = { actualizar, para, leerTexto, _leidos: leidos };
