'use strict';

/**
 * Los reportes de Turnitin en PDF —el de IA y el de similitud—, cruzados con el
 * Word que subió el tesista o con los capítulos guardados.
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
 *
 * EL REPORTE CLÁSICO DE UNA ENTREGA EN PDF
 * ----------------------------------------
 * El «Informe de originalidad» trae cada hoja de la tesis como foto, con los
 * rectángulos de color de cada fuente pintados encima en vector, y el resumen
 * (índice de similitud y fuentes primarias) al final. Esas hojas se leen con
 * OCR (`project.reporte-ocr`) y luego se cruzan igual que el texto.
 */

const ocr = require('./project.reporte-ocr');

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

/**
 * El reporte de similitud pinta cada fuente de un color. Cuenta cualquier color
 * saturado, menos el amarillo puro, que es el resaltador del propio Word del
 * tesista y sale igual en el PDF.
 */
function esColorDeCoincidencia(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''));
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  const amarilloDelWord = r > 230 && g > 230 && b < 90;
  return Math.max(r, g, b) - Math.min(r, g, b) >= 60 && !amarilloDelWord;
}

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
function resaltados(fnArray, argsArray, OPS, esColor = esColorDeIa) {
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
    else if (op === OPS.constructPath && esColor(relleno)) {
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

/**
 * De qué reporte se trata, por lo que dice la portada. Null si no es de Turnitin.
 *
 * Los espacios se juntan antes de mirar: en el PDF «ÍNDICE DE» y «SIMILITUD»
 * suelen ir en dos renglones, y con un espacio literal no se reconocía (6-oct-2026).
 * Además del reporte nuevo («Similitud general») está el clásico, que muchas
 * universidades siguen usando: «INFORME DE ORIGINALIDAD · 25 % ÍNDICE DE SIMILITUD».
 */
function tipoDe(portada) {
  const texto = String(portada).replace(/\s+/g, ' ');
  if (/detectado como IA|detected as AI/i.test(texto)) return 'ia';
  if (
    /similitud general|overall similarity|[ií]ndice de similitud|similarity index|similarity report|informe de similitud|informe de originalidad|originality report/i.test(
      texto,
    )
  ) {
    return 'similitud';
  }
  return null;
}

/**
 * El recibo digital que Turnitin da al entregar: confirma que recibió el
 * trabajo, pero no trae el porcentaje ni lo marcado. Los tesistas lo suben
 * creyendo que es el reporte (el archivo se llama «recibo_…»).
 */
function esRecibo(portada) {
  const texto = String(portada).replace(/\s+/g, ' ');
  return /recibo digital|digital receipt|este recibo (?:le )?(?:confirma|acredita)|this receipt acknowledges/i.test(texto);
}

const numero = (m) => (m ? Number(m[1]) : null);

/**
 * La cabecera del reporte de similitud: el total, el desglose por tipo de fuente
 * y las fuentes principales con su porcentaje. Lo que no aparezca queda en null
 * o vacío: Turnitin cambia de maqueta y es mejor no inventar nada.
 */
function cabeceraDeSimilitud(texto) {
  // El clásico pone el total como «25 % ÍNDICE DE SIMILITUD» y el nuevo, «25 % Similitud general».
  const porcentaje = numero(
    /(\d{1,3})\s*%\s*(?:similitud general|overall similarity|[ií]ndice\s+de\s+similitud|similarity\s+index)/i.exec(texto),
  );
  const desglose = {
    internet: numero(/(\d{1,3})\s*%\s*(?:\S+\s+)?(?:fuentes de internet|internet sources)/i.exec(texto)),
    publicaciones: numero(/(\d{1,3})\s*%\s*(?:\S+\s+)?(?:publicaciones|publications)/i.exec(texto)),
    trabajos: numero(
      /(\d{1,3})\s*%\s*(?:\S+\s+)?(?:trabajos entregados|trabajos del estudiante|submitted works|student papers)/i.exec(texto),
    ),
  };
  const fuentes = [];
  const principales = /(?:fuentes principales|top sources)([\s\S]*)$/i.exec(texto)?.[1] ?? '';
  const fila =
    /^\s*(\d{1,3})\s+(internet|publicaci[oó]n|publication|trabajos? (?:entregados?|del estudiante)|student papers?|submitted works?)\s+(.{3,120}?)\s+(<\s*1|\d{1,2})\s*%\s*$/gim;
  for (const m of principales.matchAll(fila)) {
    fuentes.push({ n: Number(m[1]), tipo: m[2], nombre: m[3].trim(), porcentaje: m[4].replace(/\s/g, '') });
    if (fuentes.length >= 15) break;
  }
  return { porcentaje, desglose, fuentes: fuentes.length > 0 ? fuentes : fuentesDelClasico(texto) };
}

const TIPO_DE_FUENTE = /^(fuente de internet|internet source|publicaci[oó]n|publication|trabajo del estudiante|student paper)$/i;

/**
 * Las «FUENTES PRIMARIAS» del reporte clásico. Ahí no van en una fila: cada
 * hoja trae primero la columna de números («1 3%», «2 2%»…) y después los
 * nombres, cada uno cerrado por su tipo («Fuente de Internet»), y un nombre
 * largo puede seguir en la hoja siguiente. Se emparejan en orden.
 */
function fuentesDelClasico(texto) {
  const desde = /fuentes primarias|primary sources/i.exec(texto);
  if (!desde) return [];
  const renglones = (trozo) =>
    trozo
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  // En la primera hoja los números salen antes que el título «FUENTES PRIMARIAS».
  const numeros = [];
  for (const linea of renglones(texto)) {
    const m = /^(\d{1,3})\s+(<\s*1|\d{1,2})\s*%$/.exec(linea);
    if (m && Number(m[1]) === numeros.length + 1) numeros.push({ n: Number(m[1]), porcentaje: m[2].replace(/\s/g, '') });
  }
  const nombres = [];
  let nombre = [];
  for (const linea of renglones(texto.slice(desde.index + desde[0].length))) {
    if (/^(\d{1,3})\s+(<\s*1|\d{1,2})\s*%$/.test(linea)) continue;
    if (TIPO_DE_FUENTE.test(linea)) {
      if (nombre.length > 0) nombres.push({ nombre: nombre.join(' '), tipo: linea.toLowerCase() });
      nombre = [];
    } else if (!/^(excluir|exclude|apagado|activo|off|on)\b/i.test(linea)) nombre.push(linea);
  }
  return numeros.slice(0, Math.min(15, nombres.length)).map((f, i) => ({ ...f, ...nombres[i] }));
}

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
 * Una hoja de la entrega que vino como foto: tiene una imagen grande y, de
 * texto, solo los numeritos de las fuentes que Turnitin pone encima.
 */
function esFoto({ contenido, fnArray, argsArray }, OPS) {
  const conLetras = contenido.items.flatMap((i) => String(i.str).match(/\S*\p{L}\S*/gu) ?? []);
  return conLetras.length < 15 && ocr.imagenesDe(fnArray, argsArray, OPS).length > 0;
}

/**
 * Lee el PDF y devuelve lo que se guarda:
 * `{ tipo, porcentaje, palabras: 'una dos tres…', ia: '0110…' }`, y en el de
 * similitud además `desglose` y `fuentes`. `ia` es la marca de cada palabra:
 * se llama así por el primer reporte que se leyó, y en el de similitud es «coincide».
 *
 * Si la entrega viene como foto (el reporte clásico de una tesis subida en PDF),
 * sin `{ ocr: true }` devuelve la cabecera y `porLeer`, cuántas hojas hay que
 * leer con OCR; con `{ ocr: true }` las lee, y eso tarda unos segundos por hoja.
 */
async function leer(buffer, { ocr: conOcr = false } = {}) {
  let pdf;
  let OPS;
  try {
    const unpdf = await import('unpdf');
    pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));
    ({ OPS } = await unpdf.getResolvedPDFJS());
  } catch {
    throw new ReporteNoValido('No se pudo abrir el PDF. ¿Está completo o tiene contraseña?');
  }

  const paginas = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const pagina = await pdf.getPage(n);
    const contenido = await pagina.getTextContent();
    const { fnArray, argsArray } = await pagina.getOperatorList();
    paginas.push({ contenido, fnArray, argsArray });
  }

  // Los renglones con su salto, para que la cabecera se lea por líneas.
  const textoDe = (p) => p.contenido.items.map((i) => `${i.str}${i.hasEOL ? '\n' : ' '}`).join('');
  // El clásico pone el «INFORME DE ORIGINALIDAD» al final, detrás de la entrega,
  // y con muchas fuentes ocupa varias hojas. Se busca en mayúsculas, como lo
  // pone Turnitin: una tesis que cite un «informe de originalidad» no cuenta.
  const resumen = paginas.filter((p, i) => i >= 3 && /INFORME DE ORIGINALIDAD|ORIGINALITY REPORT/.test(textoDe(p)));
  const portada = [...paginas.slice(0, 3), ...resumen].map(textoDe).join('\n');
  const tipo = tipoDe(portada);
  if (!tipo && esRecibo(portada)) {
    throw new ReporteNoValido(
      'Ese PDF es el recibo de entrega de Turnitin, no el reporte: confirma que lo entregaste, pero no trae ' +
        'el porcentaje ni lo marcado. En Turnitin, abre la entrega y descarga el reporte de similitud o el de IA en PDF.',
    );
  }
  if (!tipo) {
    throw new ReporteNoValido(
      'Ese PDF no parece un reporte de Turnitin: no dice «% detectado como IA», «Similitud general» ni ' +
        '«Índice de similitud». ' +
        'En Turnitin, abre la entrega y descarga el reporte de IA o el de similitud en PDF.',
    );
  }

  const esColor = tipo === 'ia' ? esColorDeIa : esColorDeCoincidencia;
  const fotos = new Set(paginas.flatMap((p, i) => (esFoto(p, OPS) ? [i + 1] : [])));
  const delOcr = new Map();
  if (conOcr && fotos.size > 0) {
    await ocr.leerPaginas(pdf, OPS, [...fotos], (n, leidas) => delOcr.set(n, leidas));
  }

  const palabras = [];
  const marcas = [];
  paginas.forEach(({ contenido, fnArray, argsArray }, i) => {
    // En una hoja-foto, el texto son los numeritos de las fuentes: no es de la entrega.
    const deLaHoja = fotos.has(i + 1)
      ? (delOcr.get(i + 1) ?? [])
      : contenido.items.flatMap((item) => palabrasDelRenglon(item));
    const cajas = resaltados(fnArray, argsArray, OPS, esColor);
    for (const palabra of deLaHoja) {
      const limpia = normalizar(palabra.texto);
      if (!limpia) continue;
      palabras.push(limpia);
      marcas.push(cajas.length > 0 && dentro(cajas, palabra) ? '1' : '0');
    }
  });

  const porLeer = conOcr ? 0 : fotos.size;
  if (palabras.length < 50 && porLeer === 0) {
    throw new ReporteNoValido('Ese PDF no tiene el texto de la entrega. Descarga el reporte completo, no solo la portada.');
  }

  const base = { tipo, palabras: palabras.join(' '), ia: marcas.join(''), ...(porLeer > 0 ? { porLeer } : {}) };
  if (tipo === 'ia') return { ...base, porcentaje: porcentajeDe(portada) ?? null };
  return { ...base, ...cabeceraDeSimilitud(paginas.map(textoDe).join('\n')) };
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
  esColorDeCoincidencia,
  tipoDe,
  esRecibo,
  cabeceraDeSimilitud,
  fuentesDelClasico,
  resaltados,
  palabrasDelRenglon,
  porcentajeDe,
  normalizar,
  leer,
  cruzar,
};
