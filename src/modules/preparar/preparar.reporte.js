'use strict';

/**
 * El reporte de IA de Turnitin en «Humanizar» (24-oct-2026).
 *
 * POR QUÉ
 * -------
 * Los Word que llegaron a 0 % a mano no se reescribieron enteros: se rehízo lo
 * que el reporte marcaba y lo limpio se dejó como estaba (Ruta 0 % de
 * /turnitin). Sin reporte el servicio no sabe qué es limpio, reescribe todo y
 * le pone huella de modelo a lo que estaba bien: con la tesis 16 se quedó en
 * «*%», y con otra tesis que a mano dio 0 %, también. Rehaciendo solo los cuatro
 * párrafos marcados de una metodología, el servicio la llevó de 36 % a 0 %.
 *
 * CÓMO
 * ----
 * El cliente sube primero el PDF (`recibir`): se lee con el mismo lector de
 * `projects/project.reporte-ia` y se guarda UNA HORA en memoria, con su dueño.
 * Después encarga «Humanizar» con el identificador: `paraElEncargo` lo cruza
 * con el Word y lo rechaza si no es de ese documento. Lo que se guarda junto al
 * Word es solo la lista de palabras y cuáles estaban marcadas, igual que en el
 * conector, y `marcadosDe` lo vuelve a cruzar al trabajar.
 *
 * Un reporte en «*%» no trae resaltado: Turnitin no enseña qué detectó por
 * debajo del 20 %. Se le dice al cliente, y humaniza sin reporte.
 */

const crypto = require('node:crypto');

const reporteIa = require('../projects/project.reporte-ia');
const { ValidationError, NotFoundError } = require('../../shared/errors/AppError');

/** Cuánto vive un reporte subido sin que se use. */
const DURACION_MS = 60 * 60 * 1000;

/** Por debajo de esta parte del Word encontrada en el reporte, no es del mismo documento. */
const COINCIDENCIA_MINIMA = 0.5;

const subidos = new Map();

function limpiarViejos(ahora = Date.now()) {
  for (const [id, subido] of subidos) if (subido.vence < ahora) subidos.delete(id);
}

/** Lee el PDF y lo guarda una hora. Devuelve lo que la web le enseña al cliente. */
async function recibir({ userId, buffer }, ahora = Date.now()) {
  if (!reporteIa.esPdf(buffer)) {
    throw new ValidationError('Eso no es un PDF. Descarga de Turnitin el reporte de IA en PDF y súbelo.');
  }
  let leido;
  try {
    leido = await reporteIa.leer(buffer);
  } catch (error) {
    if (error instanceof reporteIa.ReporteNoValido) throw new ValidationError(error.message);
    throw error;
  }
  if (leido.tipo !== 'ia') {
    throw new ValidationError(
      'Ese es el reporte de similitud. Para humanizar hace falta el de IA: en Turnitin, abre la entrega, ' +
        'entra en «Escritura con IA» y descarga ese reporte en PDF.',
    );
  }
  const marcadas = [...String(leido.ia)].filter((m) => m === '1').length;
  if (marcadas === 0) {
    throw new ValidationError(
      'Ese reporte no trae nada resaltado. Cuando Turnitin da «*%» (menos de 20 %) no enseña qué detectó, ' +
        'así que no sirve para elegir qué rehacer. Sube tu Word sin reporte y se humaniza entero.',
    );
  }

  limpiarViejos(ahora);
  const id = crypto.randomUUID();
  subidos.set(id, { userId, vence: ahora + DURACION_MS, reporte: { palabras: leido.palabras, ia: leido.ia } });
  return { reporteId: id, porcentaje: leido.porcentaje, palabrasMarcadas: marcadas };
}

/** Los párrafos marcados: `Set` de claves de `parrafos` (los de `cuerpo.cuerpoDe`). */
function marcadosDe(reporte, parrafos) {
  const cruce = reporteIa.cruzar(reporte, parrafos.map((p) => ({ id: p.clave, texto: p.texto })));
  return new Set([...cruce].filter(([, v]) => v.marcado).map(([clave]) => clave));
}

/**
 * El reporte de un encargo, comprobado contra su Word. Se consume: un reporte
 * sirve para un encargo. Devuelve lo que se guarda junto al Word.
 */
function paraElEncargo({ userId, reporteId, parrafos }, ahora = Date.now()) {
  limpiarViejos(ahora);
  const subido = subidos.get(reporteId);
  if (!subido || subido.userId !== userId) {
    throw new NotFoundError('Ese reporte ya no está: pasó más de una hora desde que lo subiste. Vuelve a subirlo.');
  }

  const conTexto = parrafos.filter((p) => !p.nivel && String(p.texto).trim());
  const cruce = reporteIa.cruzar(subido.reporte, conTexto.map((p) => ({ id: p.clave, texto: p.texto })));
  const encontrados = [...cruce.values()].filter((v) => v.porcentaje !== null).length;
  if (conTexto.length > 0 && encontrados / conTexto.length < COINCIDENCIA_MINIMA) {
    throw new ValidationError(
      'Ese reporte no es de este Word: casi nada de lo que dice se encuentra en el documento. Sube el Word ' +
        'exacto que pasaste por Turnitin, o encárgalo sin reporte.',
    );
  }
  const marcados = [...cruce.values()].filter((v) => v.marcado).length;
  if (marcados === 0) {
    throw new ValidationError(
      'Lo que marcó el reporte no cae en ningún párrafo de este Word. Sube el Word exacto que pasaste por Turnitin.',
    );
  }

  subidos.delete(reporteId);
  return { reporte: subido.reporte, marcados };
}

module.exports = { recibir, paraElEncargo, marcadosDe, DURACION_MS, COINCIDENCIA_MINIMA, _subidos: subidos };
