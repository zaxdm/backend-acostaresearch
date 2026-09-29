'use strict';

/**
 * El reporte de IA de Turnitin, en PDF, cruzado con el Word que subió el tesista.
 *
 * Para qué: el humanizador trabajaba sobre el documento entero y el Claude del
 * tesista reescribía también lo que Turnitin no había marcado. Con el reporte se
 * reescribe solo lo marcado, y lo que salió limpio sirve de muestra de su voz.
 *
 * CÓMO SE LEE EL PDF
 * ------------------
 * El reporte trae el texto de la entrega como texto de verdad (no imágenes), y
 * cada tramo marcado es un rectángulo celeste pintado debajo de las palabras
 * (relleno #52c6da, al 40 % y en modo multiplicar). pdfjs da los dos por
 * separado: el texto por renglones con su posición, y los dibujos en la lista de
 * operaciones, donde cada `constructPath` trae ya la caja del trazo. Una palabra
 * está marcada si su centro cae dentro de alguna de esas cajas.
 *
 * Solo se guarda la lista de palabras y cuáles estaban marcadas, no el cruce con
 * los párrafos: si después sube otra versión del Word, se vuelve a cruzar con la
 * nueva sin pedirle otra vez el reporte.
 *
 * CÓMO SE CRUZA CON EL WORD
 * -------------------------
 * Por trigramas de palabras normalizadas, avanzando siempre hacia delante: el
 * reporte y el Word dicen lo mismo en el mismo orden, con cortes de renglón,
 * cabeceras y números de página de por medio. Un trigrama tan común que aparece
 * cien veces («de la ley») solo vale si cae cerca de donde íbamos.
 */

/** Por debajo de este porcentaje de sus palabras, el párrafo no se da por marcado. */
const UMBRAL_MARCADO = 20;

/** Cuánto puede saltar el cruce hacia delante sin perder el hilo, en palabras. */
const VENTANA = 400;

class ReporteNoValido extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReporteNoValido';
  }
}

const esPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('latin1') === '%PDF-';

/** «Sólo generado con IA» es celeste; «parafraseado con IA», morado. Los dos cuentan. */
function esColorDeIa(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  const celeste = r < 130 && g > 170 && b > 190 && Math.abs(g - b) < 45;
  const morado = r > 130 && g < 150 && b > 200;
  return celeste || morado;
}

const multiplicar = ([a, b, c, d, e, f], [a2, b2, c2, d2, e2, f2]) => [
  a * a2 + b * c2,
  a * b2 + b * d2,
  c * a2 + d * c2,
  c * b2 + d * d2,
  e * a2 + f * c2 + e2,
  e * b2 + f * d2 + f2,
];

const aplicar = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

/**
 * Las cajas de los resaltados de IA de una página, en coordenadas de la página.
 *
 * Recibe la lista de operaciones de pdfjs tal cual (`getOperatorList`) y la
 * tabla OPS, para poder probarlo sin abrir ningún PDF.
 */
function resaltados(fnArray, argsArray, OPS) {
  let ctm = [1, 0, 0, 1, 0, 0];
  let relleno = null;
  const pila = [];
  const cajas = [];

  for (let i = 0; i < fnArray.length; i += 1) {
    const op = fnArray[i];
    const args = argsArray[i];
    if (op === OPS.save) pila.push({ ctm, relleno });
    else if (op === OPS.restore) ({ ctm, relleno } = pila.pop() ?? { ctm, relleno });
    else if (op === OPS.transform) ctm = multiplicar(args, ctm);
    else if (op === OPS.setFillRGBColor) relleno = args?.[0];
    else if (op === OPS.constructPath && esColorDeIa(relleno)) {
      const caja = Array.from(args?.at(-1) ?? []);
      if (caja.length !== 4 || caja.some((n) => !Number.isFinite(n))) continue;
      const esquinas = [
        aplicar(ctm, caja[0], caja[1]),
        aplicar(ctm, caja[2], caja[3]),
        aplicar(ctm, caja[0], caja[3]),
        aplicar(ctm, caja[2], caja[1]),
      ];
      const xs = esquinas.map((p) => p[0]);
      const ys = esquinas.map((p) => p[1]);
      cajas.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  return cajas;
}

/** Cabeceras y pies que Turnitin pone en cada hoja: no son de la entrega. */
const DE_TURNITIN = /(^|\s)(p[aá]gina \d+ de \d+|page \d+ of \d+)|trn:oid|identificador de la entrega|submission id/i;

/**
 * Las palabras de un renglón con su posición aproximada. pdfjs da el renglón
 * entero con su ancho; cada palabra se sitúa en proporción a sus caracteres,
 * que para saber si cae dentro de una caja de un renglón de alto sobra.
 */
function palabrasDelRenglon(item) {
  const str = String(item.str ?? '');
  if (!str.trim() || DE_TURNITIN.test(str)) return [];
  const [a, b, c, d, e, f] = item.transform;
  const alto = Math.hypot(c, d) || Math.hypot(a, b) || 10;
  const ancho = item.width || str.length * alto * 0.5;
  const y = f + alto * 0.3;
  const salida = [];
  for (const m of str.matchAll(/\S+/g)) {
    const centro = (m.index + m[0].length / 2) / str.length;
    salida.push({ texto: m[0], x: e + ancho * centro, y });
  }
  return salida;
}

const dentro = (cajas, { x, y }) => cajas.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

/** «¿Qué?», «Ley.» y «30364,» → «qué», «ley», «30364». */
const normalizar = (palabra) =>
  String(palabra)
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]/gu, '');

/** El porcentaje de la portada. «*%» (menos del 20 %, que Turnitin no afina) da null. */
function porcentajeDe(texto) {
  const m = /(\d{1,3}|\*)\s*%\s*(detectado como IA|detected as AI|detectado como IA)/i.exec(texto);
  if (!m) return undefined;
  return m[1] === '*' ? null : Number(m[1]);
}

/**
 * Lee el PDF y devuelve lo que se guarda:
 * `{ porcentaje, palabras: 'una dos tres…', ia: '0110…' }`.
 */
async function leer(buffer) {
  let pdf;
  let OPS;
  try {
    const unpdf = await import('unpdf');
    pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));
    ({ OPS } = await unpdf.getResolvedPDFJS());
  } catch {
    throw new ReporteNoValido('No se pudo abrir el PDF. ¿Está completo o tiene contraseña?');
  }

  const palabras = [];
  const ia = [];
  let portada = '';

  for (let n = 1; n <= pdf.numPages; n += 1) {
    const pagina = await pdf.getPage(n);
    const contenido = await pagina.getTextContent();
    if (n <= 3) portada += ` ${contenido.items.map((i) => i.str).join(' ')}`;
    const { fnArray, argsArray } = await pagina.getOperatorList();
    const cajas = resaltados(fnArray, argsArray, OPS);
    for (const item of contenido.items) {
      for (const palabra of palabrasDelRenglon(item)) {
        const limpia = normalizar(palabra.texto);
        if (!limpia) continue;
        palabras.push(limpia);
        ia.push(cajas.length > 0 && dentro(cajas, palabra) ? '1' : '0');
      }
    }
  }

  const porcentaje = porcentajeDe(portada);
  if (porcentaje === undefined) {
    throw new ReporteNoValido(
      'Ese PDF no parece el reporte de IA de Turnitin: no dice «% detectado como IA». En Turnitin, ' +
        'abre la entrega, entra en el indicador de IA y descarga ese reporte en PDF.',
    );
  }
  if (palabras.length < 50) {
    throw new ReporteNoValido('Ese PDF no tiene el texto de la entrega. Descarga el reporte de IA completo, no solo la portada.');
  }

  return { porcentaje, palabras: palabras.join(' '), ia: ia.join('') };
}

/** Primera posición de `lista` (ordenada) mayor que `desde`, o -1. */
function siguienteDe(lista, desde) {
  let bajo = 0;
  let alto = lista.length;
  while (bajo < alto) {
    const medio = (bajo + alto) >> 1;
    if (lista[medio] > desde) alto = medio;
    else bajo = medio + 1;
  }
  return bajo < lista.length ? lista[bajo] : -1;
}

/**
 * Cuánto de cada párrafo marcó Turnitin: `Map(id → { marcado, porcentaje })`.
 *
 * `porcentaje` es null si el párrafo casi no se encontró en el reporte (lo
 * añadió después, o es una tabla que Turnitin no califica).
 */
function cruzar(reporte, parrafos) {
  const del = String(reporte?.palabras ?? '').split(' ').filter(Boolean);
  const ia = String(reporte?.ia ?? '');
  const indice = new Map();
  for (let i = 0; i + 2 < del.length; i += 1) {
    const clave = `${del[i]} ${del[i + 1]} ${del[i + 2]}`;
    if (!indice.has(clave)) indice.set(clave, []);
    indice.get(clave).push(i);
  }

  const doc = [];
  for (const parrafo of parrafos) {
    for (const palabra of String(parrafo.texto).split(/\s+/)) {
      const limpia = normalizar(palabra);
      if (limpia) doc.push({ id: parrafo.id, palabra: limpia, encontrada: false, marcada: false });
    }
  }

  let ultimo = -1;
  for (let j = 0; j + 2 < doc.length; j += 1) {
    const posiciones = indice.get(`${doc[j].palabra} ${doc[j + 1].palabra} ${doc[j + 2].palabra}`);
    if (!posiciones) continue;
    // Un trigrama que sale una sola vez en todo el reporte es un ancla: vale
    // aunque quede lejos o atrás. Así se recupera el hilo después de un cuadro
    // de texto o una tabla que el Word guarda en otro orden que el PDF.
    const pos = posiciones.length === 1 ? posiciones[0] : siguienteDe(posiciones, ultimo);
    if (pos < 0) continue;
    if (posiciones.length > 1 && ultimo >= 0 && pos - ultimo > VENTANA) continue;
    for (let k = 0; k < 3; k += 1) {
      doc[j + k].encontrada = true;
      doc[j + k].marcada = doc[j + k].marcada || ia[pos + k] === '1';
    }
    ultimo = pos;
  }

  const cuentas = new Map();
  for (const w of doc) {
    const c = cuentas.get(w.id) ?? { total: 0, encontradas: 0, marcadas: 0 };
    c.total += 1;
    if (w.encontrada) c.encontradas += 1;
    if (w.marcada) c.marcadas += 1;
    cuentas.set(w.id, c);
  }

  const resultado = new Map();
  for (const [id, c] of cuentas) {
    const porcentaje = c.encontradas >= Math.max(3, c.total * 0.3) ? Math.round((100 * c.marcadas) / c.encontradas) : null;
    resultado.set(id, { porcentaje, marcado: porcentaje !== null && porcentaje >= UMBRAL_MARCADO });
  }
  return resultado;
}

module.exports = {
  ReporteNoValido,
  UMBRAL_MARCADO,
  esPdf,
  esColorDeIa,
  resaltados,
  palabrasDelRenglon,
  porcentajeDe,
  normalizar,
  leer,
  cruzar,
};
